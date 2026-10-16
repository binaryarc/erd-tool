// SQL 탭 세션 (설계 5장): 탭마다 전용 연결 1개, 자동 커밋 끔, 결과는 1,000행씩.
// - 첫 실행 때 BEGIN 하고 커밋, 롤백 전까지 같은 트랜잭션을 쓴다
// - 문장마다 SAVEPOINT 로 감싸 한 문장이 실패해도 트랜잭션 전체가 망가지지 않게 한다
// - 읽기 전용 접속은 DB 서버가 막는다(PostgreSQL, MySQL). 앱이 문장 종류를 추측하지 않는다.
//   SQL Server, Oracle 은 서버가 못 막아 DB 계정 권한으로 막는다(사용자 결정 2026-10-16). 화면에 경고를 띄운다
// - DB 호출은 DB 종류별 어댑터(adapters/)가 한다

import { rulesFor } from '../../shared/dialect';
import { isPlsqlBlock } from '../../shared/sql/text';
import type { ConnRef, SqlResult, SqlState } from '../../shared/ipc';
import type { DbAdapter, DbConn, RowCursor } from './adapters/types';
import { connectRef, connKey, resolve, type Target } from './connect';

export const FETCH_SIZE = 1000;

/** 문장 앞 공백, 한 줄 주석(--), 구간 주석 */
const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

const WRITE_FREE = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'FETCH', 'SAVEPOINT', 'RELEASE', 'SET', 'WITH', 'DESCRIBE', 'DESC']);
const SP = 'erd_stmt';

class Session {
  private cursor: RowCursor | null = null;
  private columns: { name: string }[] = [];
  inTx = false;
  dirty = false;
  readOnly: boolean;

  constructor(private conn: DbConn, private adapter: DbAdapter, readonly label: string, readonly key: string, readOnly: boolean) {
    this.readOnly = readOnly;
  }

  state(more = false): SqlState {
    const byAccount = !rulesFor(this.adapter.dialect).readOnlyByServer;
    return { label: this.label, connKey: this.key, inTx: this.inTx, dirty: this.dirty, readOnly: this.readOnly, dialect: this.adapter.dialect,
      ...(byAccount ? { readOnlyByAccount: true } : {}), more };
  }

  private async closeCursor() {
    const c = this.cursor;
    this.cursor = null;
    if (c) await c.close().catch(() => {});
  }

  async run(sql: string): Promise<SqlResult> {
    await this.closeCursor();
    const t0 = Date.now();
    // PL/SQL 블록(Oracle)은 끝 ; 가 문장의 일부다
    const plsql = this.adapter.dialect === 'oracle' && isPlsqlBlock(sql);
    const s = plsql ? sql.trim() : sql.trim().replace(/;\s*$/, '');
    // 편집기에 직접 쓴 트랜잭션 명령은 버튼과 같게 처리한다. 앞 주석은 떼고 본다
    // (떼지 않으면 「-- 메모\ncommit」 이 DB 에서 커밋된 뒤 savepoint 정리가 실패해 오류로 보였다, 2026-10-16 화면 재현)
    const head = s.replace(LEADING_COMMENTS, '');
    if (/^(commit|end)\b/i.test(head)) return { ...(await this.commit()), ms: Date.now() - t0 };
    if (/^(rollback|abort)\b(?!\s+to\b)/i.test(head)) return { ...(await this.rollback()), ms: Date.now() - t0 };
    if (!plsql && /^(begin|start\s+transaction)\b/i.test(head)) {
      if (!this.inTx) { await this.conn.begin(); this.inTx = true; }
      return this.done('BEGIN', null, t0);
    }

    if (!this.inTx) { await this.conn.begin(); this.inTx = true; }
    await this.conn.savepoint(SP);
    try {
      const cursor = this.conn.cursor(s);
      const r = await cursor.read(FETCH_SIZE);
      const rows = r.rows;
      const command = r.command;
      if (command && !WRITE_FREE.has(command)) this.dirty = true;
      this.columns = r.fields.map(name => ({ name }));
      const more = rows.length === FETCH_SIZE;
      // 커서가 열려 있는 동안 연결은 다른 문장을 받지 않는다(pg 대기열). 더 받을 행이 없을 때만 닫고 savepoint 를 푼다.
      // 열어 둔 커서의 savepoint 는 남아도 된다 (같은 이름 savepoint 를 다시 만들 수 있다)
      if (more) this.cursor = cursor;
      else {
        await cursor.close();
        await this.conn.release(SP);
      }
      return {
        command, columns: this.columns, rows, rowCount: this.columns.length ? rows.length : r.rowCount,
        ms: Date.now() - t0, state: this.state(more),
      };
    } catch (e) {
      await this.conn.rollbackTo(SP).catch(() => {});
      return this.fail(e, t0);
    }
  }

  async fetchMore(): Promise<SqlResult> {
    const t0 = Date.now();
    if (!this.cursor) return this.done('', null, t0);
    let rows: unknown[][];
    try {
      ({ rows } = await this.cursor.read(FETCH_SIZE));
    } catch (e) {
      // 더 받다가 오류가 나면(예: 1,001번째 행에서 0 으로 나누기) 커서를 버린다 (닫기는 어댑터가 안전하게 한다).
      // 이 커서를 연 문장의 savepoint 로 되돌려 트랜잭션과 앞 변경을 살린다
      const c = this.cursor;
      this.cursor = null;
      await c.close();
      await this.conn.rollbackTo(SP).catch(() => {});
      return this.fail(e, t0);
    }
    const more = rows.length === FETCH_SIZE;
    if (!more) await this.closeCursor();
    return { command: 'FETCH', columns: this.columns, rows, rowCount: rows.length, ms: Date.now() - t0, state: this.state(more) };
  }

  async commit(): Promise<SqlResult> {
    const t0 = Date.now();
    await this.closeCursor();
    if (this.inTx) await this.conn.commit();
    this.inTx = false; this.dirty = false;
    return this.done('COMMIT', null, t0);
  }

  async rollback(): Promise<SqlResult> {
    const t0 = Date.now();
    await this.closeCursor();
    if (this.inTx) await this.conn.rollback();
    this.inTx = false; this.dirty = false;
    return this.done('ROLLBACK', null, t0);
  }

  /** 이 탭만 쓰기를 허용한다. 열린 읽기 전용 트랜잭션은 바뀐 것이 없으니 롤백하고 다음 트랜잭션부터 적용 */
  async allowWrite(): Promise<SqlState> {
    await this.closeCursor();
    if (this.inTx) { await this.conn.rollback(); this.inTx = false; this.dirty = false; }
    await this.conn.setReadOnly(false);
    this.readOnly = false;
    return this.state();
  }

  async close() {
    await this.closeCursor();
    if (this.inTx) await this.conn.rollback().catch(() => {});
    await this.conn.close();
  }

  private done(command: string, rowCount: number | null, t0: number): SqlResult {
    return { command, columns: [], rows: [], rowCount, ms: Date.now() - t0, state: this.state() };
  }

  private fail(e: unknown, t0: number): SqlResult {
    return { command: '', columns: [], rows: [], rowCount: null, ms: Date.now() - t0, state: this.state(), error: this.adapter.errorInfo(e) };
  }
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
  const { conn, adapter, target: t } = await connectRef(ref, undefined, resolver);
  const s = new Session(conn, adapter, label, connKey(ref), t.readOnly);
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
