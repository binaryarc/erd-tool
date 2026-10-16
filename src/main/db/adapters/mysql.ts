// MySQL 어댑터 (STEP 9). 드라이버 mysql2 (콜백 API 의 이벤트로 행을 받고 연결을 멈췄다 풀어 1,000행씩).
// - 값은 DB 가 준 글자 그대로: 날짜, 큰 숫자(BIGINT, DECIMAL), JSON 을 글자로 받는다
// - 읽기 전용은 서버가 막는다(SET SESSION TRANSACTION READ ONLY: DDL 도 막는다)
// - DDL 은 바로 커밋되어 앞 savepoint 가 사라진다. savepoint 가 없다는 오류(1305)는 무시한다

import mysqlDriver from 'mysql2';
import type { SqlCatalog } from '../../../shared/ipc';
import type { Column, FkAction, ForeignKey, Table } from '../../../shared/model/types';
import { firstWord, type CursorRead, type DbAdapter, type DbConn, type ReverseRaw, type RowCursor, type Target } from './types';

const cell = (v: unknown) => (Buffer.isBuffer(v) ? '0x' + v.toString('hex').toUpperCase() : v);
const NO_SAVEPOINT = 1305; // ER_SP_DOES_NOT_EXIST: DDL 이 트랜잭션을 커밋해 savepoint 가 사라졌다

function wrap(c: mysqlDriver.Connection): DbConn {
  const query = <T>(sql: string, params: unknown[] = []) =>
    new Promise<T[]>((ok, fail) => c.query(sql, params, (e, rows) => (e ? fail(e) : ok((Array.isArray(rows) ? rows : []) as T[]))));
  const exec = async (sql: string) => { await query(sql); };
  const ignoreNoSavepoint = (e: unknown) => { if ((e as { errno?: number }).errno !== NO_SAVEPOINT) throw e; };
  return {
    query,
    exec,
    cursor(sql): RowCursor {
      let fields: string[] | null = null, affected: number | null = null, want = 0, done = false, err: unknown = null, sets = 0, paused = false;
      const buf: unknown[][] = [];
      let wake: (() => void) | null = null;
      const poke = () => { const w = wake; wake = null; w?.(); };
      const pause = () => { if (!paused) { paused = true; c.pause(); } };
      const resume = () => { if (paused) { paused = false; c.resume(); } };
      const qy = c.query({ sql, rowsAsArray: true });
      // 첫 결과 집합만 보여준다
      // 결과 없는 문장(SET, UPDATE)도 fields 이벤트가 빈 값으로 온다 (2026-10-16 실측)
      qy.on('fields', (f: unknown) => { if (Array.isArray(f) && ++sets === 1) fields = (f as { name: string }[]).map(x => x.name); });
      qy.on('result', (row: unknown) => {
        if (Array.isArray(row)) {
          if (sets !== 1) return;
          buf.push(row.map(cell));
          if (buf.length >= want) { pause(); poke(); }
        } else if (sets === 0) affected = (affected ?? 0) + Number((row as { affectedRows?: number }).affectedRows ?? 0);
      });
      qy.on('error', (e: unknown) => { err ??= e; });
      qy.on('end', () => { done = true; poke(); });
      return {
        async read(n): Promise<CursorRead> {
          want = n;
          while (buf.length < n && !done) await new Promise<void>(ok => { wake = ok; resume(); });
          if (err) throw err;
          const rows = buf.splice(0, n);
          return { rows, fields: fields ?? [], command: firstWord(sql), rowCount: fields ? null : affected };
        },
        // MySQL 은 받던 결과를 중간에 끊지 못한다: 남은 행을 버리며 끝까지 받는다
        async close() {
          if (done) return;
          want = Infinity;
          buf.length = 0;
          qy.removeAllListeners('result');
          qy.on('result', () => {});
          await new Promise<void>(ok => { wake = ok; resume(); });
        },
      };
    },
    begin: () => exec('START TRANSACTION'),
    commit: () => exec('COMMIT'),
    rollback: () => exec('ROLLBACK'),
    savepoint: n => exec(`SAVEPOINT ${n}`),
    rollbackTo: n => exec(`ROLLBACK TO SAVEPOINT ${n}`).catch(ignoreNoSavepoint),
    release: n => exec(`RELEASE SAVEPOINT ${n}`).catch(ignoreNoSavepoint),
    setReadOnly: on => exec(`SET SESSION TRANSACTION ${on ? 'READ ONLY' : 'READ WRITE'}`),
    close: () => new Promise<void>(ok => c.end(() => ok())),
  };
}

/** 정의 안 기본값(COLUMN_DEFAULT)은 따옴표가 없다. 식은 DEFAULT_GENERATED 표시가 있다 */
function defaultText(def: string | null, extra: string, type: string): string | undefined {
  if (def === null) return undefined;
  if (/DEFAULT_GENERATED/i.test(extra)) return /^(current_timestamp|now|localtime|localtimestamp)\b/i.test(def) ? def : `(${def})`;
  if (/^(tinyint|smallint|mediumint|int|bigint|decimal|numeric|float|double|real)\b/i.test(type) || /^b'[01]*'$/.test(def)) return def;
  return `'${def.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function stripParens(s: string): string {
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0 && i < s.length - 1) return s;
  }
  return s.slice(1, -1);
}

const FK_ACTION: Record<string, FkAction | undefined> = { RESTRICT: 'restrict', CASCADE: 'cascade', 'SET NULL': 'set null', 'SET DEFAULT': 'set default' };

async function reverse(c: DbConn, schema: string): Promise<ReverseRaw> {
  const q = <T>(sql: string) => c.query<T>(sql, [schema]);
  const tables = await q<{ t: string; cmt: string }>(`
    SELECT TABLE_NAME t, TABLE_COMMENT cmt FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`);
  const cols = await q<{ t: string; col: string; typ: string; nullable: string; def: string | null; extra: string; gen: string; cmt: string }>(`
    SELECT TABLE_NAME t, COLUMN_NAME col, COLUMN_TYPE typ, IS_NULLABLE nullable, COLUMN_DEFAULT def, EXTRA extra,
      GENERATION_EXPRESSION gen, COLUMN_COMMENT cmt
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  const keys = await q<{ t: string; name: string; kind: string; col: string }>(`
    SELECT k.TABLE_NAME t, k.CONSTRAINT_NAME name, c.CONSTRAINT_TYPE kind, k.COLUMN_NAME col
    FROM information_schema.TABLE_CONSTRAINTS c JOIN information_schema.KEY_COLUMN_USAGE k
      ON k.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.CONSTRAINT_NAME = c.CONSTRAINT_NAME
    WHERE c.CONSTRAINT_SCHEMA = ? AND c.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ORDER BY 1, 2, k.ORDINAL_POSITION`);
  const fks = await q<{ t: string; name: string; ft: string; del: string; upd: string; col: string; fcol: string }>(`
    SELECT k.TABLE_NAME t, k.CONSTRAINT_NAME name, r.REFERENCED_TABLE_NAME ft, r.DELETE_RULE del, r.UPDATE_RULE upd, k.COLUMN_NAME col, k.REFERENCED_COLUMN_NAME fcol
    FROM information_schema.REFERENTIAL_CONSTRAINTS r JOIN information_schema.KEY_COLUMN_USAGE k
      ON k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA AND k.TABLE_NAME = r.TABLE_NAME AND k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
    WHERE r.CONSTRAINT_SCHEMA = ? ORDER BY 1, 2, k.ORDINAL_POSITION`);
  const checks = await q<{ t: string; name: string; def: string }>(`
    SELECT c.TABLE_NAME t, c.CONSTRAINT_NAME name, k.CHECK_CLAUSE def
    FROM information_schema.TABLE_CONSTRAINTS c JOIN information_schema.CHECK_CONSTRAINTS k
      ON k.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = c.CONSTRAINT_NAME
    WHERE c.CONSTRAINT_SCHEMA = ? AND c.CONSTRAINT_TYPE = 'CHECK' ORDER BY 1, 2`);
  // PK 와 UNIQUE 제약이 만든 인덱스는 뺀다 (MySQL 은 UNIQUE 제약과 인덱스 이름이 같다)
  const indexes = await q<{ t: string; name: string; nonuniq: number; col: string | null; expr: string | null; typ: string; sub: number | null }>(`
    SELECT s.TABLE_NAME t, s.INDEX_NAME name, s.NON_UNIQUE nonuniq, s.COLUMN_NAME col, s.EXPRESSION expr, s.INDEX_TYPE typ, s.SUB_PART sub
    FROM information_schema.STATISTICS s
    WHERE s.TABLE_SCHEMA = ? AND s.INDEX_NAME <> 'PRIMARY'
      AND NOT EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS c WHERE c.CONSTRAINT_SCHEMA = s.TABLE_SCHEMA
        AND c.TABLE_NAME = s.TABLE_NAME AND c.CONSTRAINT_NAME = s.INDEX_NAME AND c.CONSTRAINT_TYPE = 'UNIQUE')
    ORDER BY 1, 2, s.SEQ_IN_INDEX`);
  const others = await c.query<{ kind: string; name: string }>(`
    SELECT '뷰' kind, TABLE_NAME name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?
    UNION ALL SELECT '트리거', TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
    UNION ALL SELECT IF(ROUTINE_TYPE = 'PROCEDURE', '프로시저', '함수'), ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
    ORDER BY 1, 2`, [schema, schema, schema]);

  const byName = new Map<string, Table>();
  for (const t of tables) byName.set(t.t, { id: '', name: t.t, comment: t.cmt ?? '', columns: [], pk: [], fks: [], uniques: [], indexes: [] });
  const warnings: string[] = [];
  for (const c of cols) {
    const t = byName.get(c.t);
    if (!t) continue; // 뷰 컬럼
    const col: Column = { name: c.col, type: c.typ, notNull: c.nullable === 'NO' };
    if (/auto_increment/i.test(c.extra)) col.identity = 'default';
    if (/GENERATED/i.test(c.extra) && c.gen) {
      col.generated = stripParens(c.gen);
      if (/VIRTUAL/i.test(c.extra)) warnings.push(`컬럼 ${c.t}.${c.col}: 저장하지 않는(VIRTUAL) 생성 컬럼이다. 다시 만들면 STORED 가 된다`);
    } else {
      const d = defaultText(c.def, c.extra, c.typ);
      if (d !== undefined) col.default = d;
    }
    if (/on update/i.test(c.extra)) warnings.push(`컬럼 ${c.t}.${c.col}: ${c.extra.replace(/DEFAULT_GENERATED\s*/i, '')} 는 모델에 담지 않았다`);
    if (c.cmt) col.comment = c.cmt;
    t.columns.push(col);
  }
  const group = <T extends { t: string; name: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(`${r.t}\u0000${r.name}`, [...(m.get(`${r.t}\u0000${r.name}`) ?? []), r]);
    return [...m.values()];
  };
  for (const g of group(keys)) {
    const t = byName.get(g[0].t);
    if (!t) continue;
    if (g[0].kind === 'PRIMARY KEY') t.pk = g.map(x => x.col);
    else t.uniques.push({ name: g[0].name, columns: g.map(x => x.col) });
  }
  for (const g of group(fks)) {
    const t = byName.get(g[0].t);
    if (!t) continue;
    const fk: ForeignKey = { name: g[0].name, columns: g.map(x => x.col), refTable: g[0].ft, refColumns: g.map(x => x.fcol) };
    if (FK_ACTION[g[0].del]) fk.onDelete = FK_ACTION[g[0].del];
    if (FK_ACTION[g[0].upd]) fk.onUpdate = FK_ACTION[g[0].upd];
    t.fks.push(fk);
  }
  // CHECK_CLAUSE 는 문자열 따옴표와 역슬래시 앞에 역슬래시를 붙여 돌려준다 (MySQL 8 실측). SQL 에 다시 쓸 수 있게 푼다
  for (const k of checks) (byName.get(k.t)!.checks ??= []).push({ name: k.name, definition: `CHECK ${k.def.replace(/\\(['\\])/g, '$1')}` });
  for (const g of group(indexes)) {
    const t = byName.get(g[0].t);
    if (!t) continue;
    const notes = [g[0].typ !== 'BTREE' && g[0].typ, g.some(x => x.sub !== null) && '앞부분 길이'].filter(Boolean);
    if (notes.length) warnings.push(`인덱스 ${g[0].name}: ${notes.join(', ')} 정보는 모델에 담지 않았다`);
    t.indexes.push({ name: g[0].name, columns: g.map(x => x.col ?? x.expr ?? ''), unique: Number(g[0].nonuniq) === 0 });
  }
  for (const o of others) warnings.push(`${o.kind} ${o.name}: 모델에 담지 않는다`);
  return { tables: [...byName.values()], sequences: [], functions: [], warnings };
}

async function count(c: DbConn, schema: string) {
  const [r] = await c.query<{ tables: number; fks: number }>(`SELECT
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE') tables,
    (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?) fks`, [schema, schema]);
  return { tables: Number(r.tables), fks: Number(r.fks) };
}

async function catalog(c: DbConn): Promise<SqlCatalog> {
  const rels = await c.query<{ sch: string; name: string; kind: string; cmt: string }>(`
    SELECT TABLE_SCHEMA sch, TABLE_NAME name, TABLE_TYPE kind, TABLE_COMMENT cmt FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`);
  const cols = await c.query<{ tbl: string; name: string; typ: string; cmt: string }>(`
    SELECT TABLE_NAME tbl, COLUMN_NAME name, COLUMN_TYPE typ, COLUMN_COMMENT cmt FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  const fns = await c.query<{ name: string }>(`SELECT ROUTINE_NAME name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = 'FUNCTION' ORDER BY 1`);
  const byTable = new Map<string, SqlCatalog['tables'][number]>();
  const tables = rels.map(r => {
    // 뷰의 TABLE_COMMENT 는 'VIEW' 다
    const t = { name: r.name, schema: r.sch, kind: r.kind === 'VIEW' ? 'view' as const : 'table' as const, comment: r.kind === 'VIEW' ? '' : r.cmt ?? '', columns: [] as SqlCatalog['tables'][number]['columns'] };
    byTable.set(r.name, t);
    return t;
  });
  for (const x of cols) byTable.get(x.tbl)?.columns.push({ name: x.name, type: x.typ, comment: x.cmt ?? '' });
  return { dialect: 'mysql', tables, functions: fns.map(f => ({ name: f.name, args: '', returns: '' })) };
}

export const mysqlAdapter: DbAdapter = {
  dialect: 'mysql',
  async connect(t: Target, readOnly: boolean) {
    const c = mysqlDriver.createConnection({
      host: t.host, port: t.port, database: t.database, user: t.user, password: t.password, connectTimeout: 10_000,
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, charset: 'utf8mb4',
    });
    await new Promise<void>((ok, fail) => c.connect(e => (e ? fail(e) : ok())));
    c.on('error', () => {});
    const conn = wrap(c);
    if (readOnly) await conn.setReadOnly(true);
    return conn;
  },
  isAuthError: e => (e as { errno?: number }).errno === 1045,
  errorInfo(e) {
    const err = e as Error & { code?: string; sqlMessage?: string };
    return { message: err.sqlMessage ?? err.message, code: err.code };
  },
  defaultSchema: t => t.schema || t.database,
  reverse,
  count,
  catalog,
  async serverInfo(c) {
    const [v] = await c.query<{ db: string; ver: string }>('SELECT DATABASE() db, VERSION() ver');
    return { database: v.db, version: `MySQL ${v.ver}` };
  },
  // 읽기 전용 트랜잭션(DDL 도 막힌다). 시간 제한은 SELECT 에만 걸린다
  async beginAiQuery(c, timeoutMs) {
    await c.exec(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(1000, Math.floor(timeoutMs))}`);
    await c.exec('START TRANSACTION READ ONLY');
  },
};
