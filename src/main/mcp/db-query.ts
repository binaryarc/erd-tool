// MCP db_query (STEP 8): AI 가 부르는 조회. 모든 접속에서 읽기 전용이다(사용자 결정 2026-10-16).
// 막는 방법은 DB 종류별 어댑터(beginAiQuery)가 정한다. PostgreSQL 은 세 겹(연결 읽기 전용, BEGIN READ ONLY, 한 번에 문장 하나).
// SQL Server, Oracle 은 서버가 못 막아 DB 계정 권한으로 막아야 한다(사용자 결정 2026-10-16). 결과 끝에 그 경고를 붙인다.
// 그래도 끝의 롤백은 소용없을 때가 있어(SQL Server 는 문장을 묶어 보내 COMMIT 이 먼저 돈다, Oracle 은 DDL 이 자동 커밋)
// 두 DB 는 DB 에 보내기 전에 앱이 검사한다(checkAiSql): SELECT, WITH 로 시작하는 한 문장만, 쓰기 낱말은 없어야 한다.
// 연결은 부를 때마다 새로 열고 끝에 롤백 후 닫는다. 결과는 앞 몇 행과 전체 행 수(상한까지 셈)만 글로 돌려준다.

import { rulesFor } from '../../shared/dialect';
import type { ConnRef } from '../../shared/ipc';
import { connectRef } from '../db/connect';

export interface QueryOptions { show?: number; count?: number; timeoutMs?: number }

const cellText = (v: unknown) => {
  const s = v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const one = s.replace(/\s*\n\s*/g, ' ');
  return one.length > 80 ? one.slice(0, 79) + '…' : one;
};

/** 문자열, 따옴표 이름, 주석을 빈칸으로 바꾼다 (그 안의 ; 와 낱말은 검사하지 않게) */
const stripLiterals = (sql: string) =>
  sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');

/** 읽기에 없어야 할 낱말. INTO 는 SQL Server SELECT INTO 가 테이블을 만들어서, UPDATE 는 WITH ... UPDATE, FOR UPDATE 까지 막는다 */
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|INTO|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMIT|ROLLBACK|SAVEPOINT|BEGIN|DECLARE|EXEC|EXECUTE|CALL|SET|LOCK)\b/i;

/** AI 조회로 보내도 되는지. 안 되면 그 이유, 되면 null (서버가 읽기 전용을 막지 못하는 DB 에만 쓴다) */
export function checkAiSql(sql: string): string | null {
  const body = stripLiterals(sql).trim().replace(/;\s*$/, '');
  if (body.includes(';')) return 'AI 조회는 문장 하나만 실행합니다';
  const first = body.match(/^[a-z]+/i)?.[0].toUpperCase() ?? '';
  if (first !== 'SELECT' && first !== 'WITH') return `AI 조회는 SELECT, WITH 로 시작하는 조회만 실행합니다 (받은 문장: ${first || '알 수 없음'})`;
  const w = body.match(WRITE_WORDS)?.[1];
  return w ? `AI 조회는 읽기만 합니다. ${w.toUpperCase()} 이(가) 들어 있어 실행하지 않았습니다` : null;
}

export async function dbQuery(ref: ConnRef, sql: string, { show = 50, count = 1000, timeoutMs = 30_000 }: QueryOptions = {}): Promise<string> {
  const text = sql.trim().replace(/;\s*$/, '');
  if (!text) throw new Error('SQL 이 비었다');
  const { conn, adapter } = await connectRef(ref, true);
  const note = rulesFor(adapter.dialect).readOnlyByServer ? '읽기 전용 조회' : '끝에 롤백함. 쓰기는 DB 계정 권한으로 막아야 한다';
  try {
    const refused = rulesFor(adapter.dialect).readOnlyByServer ? null : checkAiSql(text);
    if (refused) throw new Error(refused);
    await adapter.beginAiQuery(conn, timeoutMs);
    const cursor = conn.cursor(text);
    const r = await cursor.read(count + 1);
    await cursor.close();
    const { rows, fields: cols } = r;
    if (!cols.length) return `${r.command || '실행'} 완료 (행 없음${rulesFor(adapter.dialect).readOnlyByServer ? '' : `, ${note}`})`;
    const total = rows.length > count ? `${count}행 넘음` : `${rows.length}행`;
    return [
      cols.join(' | '),
      ...rows.slice(0, show).map(row => row.map(cellText).join(' | ')),
      `(전체 ${total}${rows.length > show ? `, 앞 ${show}행만 보임` : ''}. ${note})`,
    ].join('\n');
  } finally {
    await conn.rollback().catch(() => {});
    await conn.close();
  }
}
