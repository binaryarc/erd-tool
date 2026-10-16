// MCP db_query (STEP 8): AI 가 부르는 조회. 모든 접속에서 읽기 전용이다(사용자 결정 2026-10-16).
// 세 겹으로 막는다: 연결의 default_transaction_read_only, BEGIN READ ONLY(첫 조회를 먼저 해 읽기-쓰기 전환도 막음), 확장 프로토콜(pg-cursor)이라 한 번에 문장 하나만.
// 연결은 부를 때마다 새로 열고 끝에 롤백 후 닫는다. 결과는 앞 몇 행과 전체 행 수(상한까지 셈)만 글로 돌려준다.

import Cursor from 'pg-cursor';
import pg from 'pg';
import type { ConnRef } from '../../shared/ipc';
import { connectRef } from '../db/connect';

export interface QueryOptions { show?: number; count?: number; timeoutMs?: number }

const cellText = (v: unknown) => {
  const s = v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const one = s.replace(/\s*\n\s*/g, ' ');
  return one.length > 80 ? one.slice(0, 79) + '…' : one;
};

function read(cursor: Cursor, n: number): Promise<{ rows: unknown[][]; result: pg.QueryResult }> {
  return new Promise((ok, fail) => cursor.read(n, (err, rows, result) => (err ? fail(err) : ok({ rows: rows as unknown[][], result }))));
}

export async function dbQuery(ref: ConnRef, sql: string, { show = 50, count = 1000, timeoutMs = 30_000 }: QueryOptions = {}): Promise<string> {
  const text = sql.trim().replace(/;\s*$/, '');
  if (!text) throw new Error('SQL 이 비었다');
  const { client } = await connectRef(ref, true);
  try {
    await client.query(`set statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT 1'); // 첫 조회 뒤에는 트랜잭션을 읽기-쓰기로 바꿀 수 없다 (SET TRANSACTION READ WRITE 차단)
    const cursor = client.query(new Cursor(text, undefined, { rowMode: 'array' }));
    const { rows, result } = await read(cursor, count + 1);
    await cursor.close().catch(() => {});
    const cols = (result.fields ?? []).map(f => f.name);
    if (!cols.length) return `${result.command ?? '실행'} 완료 (행 없음)`;
    const total = rows.length > count ? `${count}행 넘음` : `${rows.length}행`;
    return [
      cols.join(' | '),
      ...rows.slice(0, show).map(r => r.map(cellText).join(' | ')),
      `(전체 ${total}${rows.length > show ? `, 앞 ${show}행만 보임` : ''}. 읽기 전용 조회)`,
    ].join('\n');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}
