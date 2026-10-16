// MCP db_query (STEP 8): AI 가 부르는 조회. 모든 접속에서 읽기 전용이다(사용자 결정 2026-10-16).
// 막는 방법은 DB 종류별 어댑터(beginAiQuery)가 정한다. PostgreSQL 은 세 겹(연결 읽기 전용, BEGIN READ ONLY, 한 번에 문장 하나).
// SQL Server, Oracle 은 서버가 못 막아 DB 계정 권한으로 막아야 한다(사용자 결정 2026-10-16). 결과 끝에 그 경고를 붙인다.
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

export async function dbQuery(ref: ConnRef, sql: string, { show = 50, count = 1000, timeoutMs = 30_000 }: QueryOptions = {}): Promise<string> {
  const text = sql.trim().replace(/;\s*$/, '');
  if (!text) throw new Error('SQL 이 비었다');
  const { conn, adapter } = await connectRef(ref, true);
  const note = rulesFor(adapter.dialect).readOnlyByServer ? '읽기 전용 조회' : '끝에 롤백함. 쓰기는 DB 계정 권한으로 막아야 한다';
  try {
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
