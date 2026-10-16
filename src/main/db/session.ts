// SQL 탭 세션 (설계 5장): 탭마다 전용 연결 1개, 자동 커밋 끔, 결과는 1,000행씩.
// - 첫 실행 때 BEGIN 하고 커밋, 롤백 전까지 같은 트랜잭션을 쓴다
// - 문장마다 SAVEPOINT 로 감싸 한 문장이 실패해도 트랜잭션 전체가 망가지지 않게 한다
// - 읽기 전용 접속은 DB 서버가 막는다(default_transaction_read_only). 앱이 문장 종류를 추측하지 않는다

import pg from 'pg';
import Cursor from 'pg-cursor';
import type { ConnRef, SqlResult, SqlState } from '../../shared/ipc';
import { connectRef, connKey, resolve, type Target } from './connect';

export const FETCH_SIZE = 1000;

// DB 도구라 값은 DB 가 준 글자 그대로 보여준다 (날짜, numeric, json, bytea, 배열). 숫자와 참거짓만 바꾼다
const KEEP_PARSED = new Set([16, 21, 23, 26, 700, 701]); // bool, int2, int4, oid, float4, float8
const rawTypes = {
  getTypeParser: (oid: number, format?: string) =>
    KEEP_PARSED.has(oid) ? pg.types.getTypeParser(oid, format as 'text') : (v: string) => v,
};

/** 문장 앞 공백, 한 줄 주석(--), 구간 주석 */
const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

const WRITE_FREE = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'FETCH', 'SAVEPOINT', 'RELEASE', 'SET']);

class Session {
  private cursor: Cursor | null = null;
  private columns: { name: string }[] = [];
  inTx = false;
  dirty = false;
  readOnly: boolean;

  constructor(private client: pg.Client, readonly label: string, readonly key: string, readOnly: boolean) {
    this.readOnly = readOnly;
  }

  state(more = false): SqlState {
    return { label: this.label, connKey: this.key, inTx: this.inTx, dirty: this.dirty, readOnly: this.readOnly, more };
  }

  private async closeCursor() {
    const c = this.cursor;
    this.cursor = null;
    if (c) await c.close().catch(() => {});
  }

  async run(sql: string): Promise<SqlResult> {
    await this.closeCursor();
    const t0 = Date.now();
    const s = sql.trim().replace(/;\s*$/, '');
    // 편집기에 직접 쓴 트랜잭션 명령은 버튼과 같게 처리한다. 앞 주석은 떼고 본다
    // (떼지 않으면 「-- 메모\ncommit」 이 DB 에서 커밋된 뒤 savepoint 정리가 실패해 오류로 보였다, 2026-10-16 화면 재현)
    const head = s.replace(LEADING_COMMENTS, '');
    if (/^(commit|end)\b/i.test(head)) return { ...(await this.commit()), ms: Date.now() - t0 };
    if (/^(rollback|abort)\b(?!\s+to\b)/i.test(head)) return { ...(await this.rollback()), ms: Date.now() - t0 };
    if (/^(begin|start\s+transaction)\b/i.test(head)) {
      if (!this.inTx) { await this.client.query('BEGIN'); this.inTx = true; }
      return this.done('BEGIN', null, t0);
    }

    if (!this.inTx) { await this.client.query('BEGIN'); this.inTx = true; }
    await this.client.query('SAVEPOINT erd_stmt');
    try {
      const cursor = this.client.query(new Cursor(s, undefined, { rowMode: 'array', types: rawTypes }));
      const { rows, result } = await read(cursor, FETCH_SIZE);
      const command = result.command ?? '';
      if (command && !WRITE_FREE.has(command)) this.dirty = true;
      this.columns = (result.fields ?? []).map(f => ({ name: f.name }));
      const more = rows.length === FETCH_SIZE;
      // 커서가 열려 있는 동안 연결은 다른 문장을 받지 않는다(pg 대기열). 더 받을 행이 없을 때만 닫고 savepoint 를 푼다.
      // 열어 둔 커서의 savepoint 는 남아도 된다 (같은 이름 savepoint 를 다시 만들 수 있다)
      if (more) this.cursor = cursor;
      else {
        await cursor.close().catch(() => {});
        await this.client.query('RELEASE SAVEPOINT erd_stmt');
      }
      return {
        command, columns: this.columns, rows, rowCount: this.columns.length ? rows.length : result.rowCount ?? null,
        ms: Date.now() - t0, state: this.state(more),
      };
    } catch (e) {
      await this.client.query('ROLLBACK TO SAVEPOINT erd_stmt').catch(() => {});
      return this.fail(e, t0);
    }
  }

  async fetchMore(): Promise<SqlResult> {
    const t0 = Date.now();
    if (!this.cursor) return this.done('', null, t0);
    let rows: unknown[][];
    try {
      ({ rows } = await read(this.cursor, FETCH_SIZE));
    } catch (e) {
      // 더 받다가 오류가 나면(예: 1,001번째 행에서 0 으로 나누기) 커서는 닫지 않고 버린다.
      // pg-cursor 는 오류 때 이미 동기화를 마쳐, close() 가 다시 오지 않을 응답을 기다리며 끝나지 않는다(다음 실행이 멈췄다, 2026-10-16 화면 재현).
      // 이 커서를 연 문장의 savepoint 로 되돌려 트랜잭션과 앞 변경을 살린다
      this.cursor = null;
      await this.client.query('ROLLBACK TO SAVEPOINT erd_stmt').catch(() => {});
      return this.fail(e, t0);
    }
    const more = rows.length === FETCH_SIZE;
    if (!more) await this.closeCursor();
    return { command: 'FETCH', columns: this.columns, rows, rowCount: rows.length, ms: Date.now() - t0, state: this.state(more) };
  }

  async commit(): Promise<SqlResult> {
    const t0 = Date.now();
    await this.closeCursor();
    if (this.inTx) await this.client.query('COMMIT');
    this.inTx = false; this.dirty = false;
    return this.done('COMMIT', null, t0);
  }

  async rollback(): Promise<SqlResult> {
    const t0 = Date.now();
    await this.closeCursor();
    if (this.inTx) await this.client.query('ROLLBACK');
    this.inTx = false; this.dirty = false;
    return this.done('ROLLBACK', null, t0);
  }

  /** 이 탭만 쓰기를 허용한다. 열린 읽기 전용 트랜잭션은 바뀐 것이 없으니 롤백하고 다음 트랜잭션부터 적용 */
  async allowWrite(): Promise<SqlState> {
    await this.closeCursor();
    if (this.inTx) { await this.client.query('ROLLBACK'); this.inTx = false; this.dirty = false; }
    await this.client.query('set default_transaction_read_only = off');
    this.readOnly = false;
    return this.state();
  }

  async close() {
    await this.closeCursor();
    if (this.inTx) await this.client.query('ROLLBACK').catch(() => {});
    await this.client.end().catch(() => {});
  }

  private done(command: string, rowCount: number | null, t0: number): SqlResult {
    return { command, columns: [], rows: [], rowCount, ms: Date.now() - t0, state: this.state() };
  }

  private fail(e: unknown, t0: number): SqlResult {
    const err = e as Error & { position?: string; code?: string };
    return { command: '', columns: [], rows: [], rowCount: null, ms: Date.now() - t0, state: this.state(),
      error: { message: err.message, code: err.code, position: err.position ? Number(err.position) : undefined } };
  }
}

function read(cursor: Cursor, n: number): Promise<{ rows: unknown[][]; result: pg.QueryResult }> {
  return new Promise((ok, fail) => cursor.read(n, (err, rows, result) => (err ? fail(err) : ok({ rows: rows as unknown[][], result }))));
}

const sessions = new Map<string, Session>();

const get = (tabId: string) => {
  const s = sessions.get(tabId);
  if (!s) throw new Error('이 탭은 아직 접속하지 않았다');
  return s;
};

/** 탭에 접속한다. 이미 접속돼 있으면 닫고 새로 연다 (커밋 안 한 변경이 있으면 화면이 먼저 물어본다) */
export async function openSession(tabId: string, ref: ConnRef, label: string, resolver: (r: ConnRef) => Promise<Target> = resolve): Promise<SqlState> {
  await closeSession(tabId);
  const { client, target: t } = await connectRef(ref, undefined, resolver);
  const s = new Session(client, label, connKey(ref), t.readOnly);
  sessions.set(tabId, s);
  return s.state();
}

export const runSql = (tabId: string, sql: string) => get(tabId).run(sql);
export const fetchMore = (tabId: string) => get(tabId).fetchMore();
export const commitTx = (tabId: string) => get(tabId).commit();
export const rollbackTx = (tabId: string) => get(tabId).rollback();
export const allowWrite = (tabId: string) => get(tabId).allowWrite();

export async function closeSession(tabId: string) {
  const s = sessions.get(tabId);
  sessions.delete(tabId);
  await s?.close();
}

/** 커밋 안 한 변경이 있는 탭 (창 닫기 확인용) */
export const dirtyTabs = () => [...sessions].filter(([, s]) => s.dirty).map(([id, s]) => ({ tabId: id, label: s.label }));

export async function closeAll() {
  await Promise.all([...sessions.keys()].map(closeSession));
}
