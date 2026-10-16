// Oracle 어댑터 (STEP 9). 드라이버 oracledb 7 Thin 모드 (Oracle 클라이언트 설치 없이 접속).
// - 트랜잭션은 첫 변경 문장에서 저절로 시작한다(autoCommit 끔). savepoint 는 SAVEPOINT, 풀기는 없다
// - 결과는 ResultSet.getRows 로 1,000행씩. 숫자, 날짜, CLOB 은 글자로 받는다 (날짜 형식은 세션 NLS 로 고정)
// - 서버가 읽기 전용을 막지 못한다(DDL 이 트랜잭션을 끝낸다). 읽기 전용 접속은 DB 계정 권한으로 막는다(사용자 결정 2026-10-16)
// - DDL 은 바로 커밋되어 앞 savepoint 가 사라진다. savepoint 가 없다는 오류(ORA-01086)는 무시한다

import oracledb from 'oracledb';
import type { SqlCatalog } from '../../../shared/ipc';
import type { Column, FkAction, ForeignKey, Table } from '../../../shared/model/types';
import { firstWord, type CursorRead, type DbAdapter, type DbConn, type ReverseRaw, type RowCursor, type Target } from './types';

const NO_SAVEPOINT = 1086;
const AS_TEXT = new Set<oracledb.DbType>([oracledb.DB_TYPE_NUMBER, oracledb.DB_TYPE_DATE, oracledb.DB_TYPE_TIMESTAMP, oracledb.DB_TYPE_TIMESTAMP_TZ,
  oracledb.DB_TYPE_TIMESTAMP_LTZ, oracledb.DB_TYPE_CLOB, oracledb.DB_TYPE_NCLOB, oracledb.DB_TYPE_LONG, oracledb.DB_TYPE_INTERVAL_DS, oracledb.DB_TYPE_INTERVAL_YM]);
/** 값은 DB 가 보여주는 글자 그대로 (숫자도 정밀도를 잃지 않게 글자) */
const fetchTypeHandler = (m: oracledb.Metadata<unknown>) => (m.dbType && AS_TEXT.has(m.dbType) ? { type: oracledb.STRING } : undefined);
const cell = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('hex').toUpperCase() : v);

interface OraConn extends DbConn {
  raw: oracledb.Connection;
}

function wrap(c: oracledb.Connection): OraConn {
  const ignoreNoSavepoint = (e: unknown) => { if ((e as { errorNum?: number }).errorNum !== NO_SAVEPOINT) throw e; };
  const conn: OraConn = {
    raw: c,
    // 사전 조회: 열 이름은 소문자 별칭으로 받는다 (Oracle 은 따옴표 없는 별칭을 대문자로 돌려준다)
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await c.execute(sql, params as oracledb.BindParameters, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler: (m: oracledb.Metadata<unknown>) => (m.dbType === oracledb.DB_TYPE_LONG || m.dbType === oracledb.DB_TYPE_CLOB ? { type: oracledb.STRING } : undefined) });
      return ((r.rows ?? []) as Record<string, unknown>[]).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]))) as T[];
    },
    exec: async sql => { await c.execute(sql); },
    cursor(sql): RowCursor {
      let rs: oracledb.ResultSet<unknown[]> | undefined, fields: string[] = [], rowCount: number | null = null, started: Promise<void> | null = null, done = false;
      const start = () => (started ??= (async () => {
        const r = await c.execute<unknown[]>(sql, [], { resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler });
        if (r.resultSet) { rs = r.resultSet; fields = (r.metaData ?? []).map(m => m.name); } else { rowCount = r.rowsAffected ?? null; done = true; }
      })());
      return {
        async read(n): Promise<CursorRead> {
          await start();
          let rows: unknown[][] = [];
          if (rs && !done) {
            rows = (await rs.getRows(n)).map(r => r.map(cell));
            if (rows.length < n) { done = true; await rs.close().catch(() => {}); }
          }
          return { rows, fields, command: firstWord(sql), rowCount };
        },
        async close() {
          if (rs && !done) { done = true; await rs.close().catch(() => {}); }
        },
      };
    },
    begin: async () => {},
    commit: () => c.commit(),
    rollback: () => c.rollback(),
    savepoint: n => conn.exec(`SAVEPOINT ${n}`),
    rollbackTo: n => conn.exec(`ROLLBACK TO SAVEPOINT ${n}`).catch(ignoreNoSavepoint),
    release: async () => {},
    setReadOnly: async () => {},
    close: async () => { await c.close().catch(() => {}); },
  };
  return conn;
}

/** 사전의 타입 → 글자 (소문자) */
function typeText(c: { typ: string; clen: number; cused: string | null; prec: number | null; scale: number | null }): string {
  const t = c.typ.toLowerCase();
  if (t === 'varchar2' || t === 'char') return `${t}(${c.clen}${c.cused === 'C' ? ' char' : ''})`;
  if (t === 'nvarchar2' || t === 'nchar' || t === 'raw') return `${t}(${c.clen || ''})`.replace('()', '');
  if (t === 'number') {
    if (c.prec === null) return c.scale === 0 ? 'integer' : 'number';
    return c.scale ? `number(${c.prec},${c.scale})` : `number(${c.prec})`;
  }
  if (t === 'float') return c.prec ? `float(${c.prec})` : 'float';
  return t;
}

const FK_ACTION: Record<string, FkAction | undefined> = { CASCADE: 'cascade', 'SET NULL': 'set null' };
/** 휴지통(BIN$)에 들어간 테이블은 뺀다 */
const LIVE = `t.dropped = 'NO' AND t.table_name NOT LIKE 'BIN$%' AND t.secondary = 'N' AND t.nested = 'NO' AND (t.iot_type IS NULL OR t.iot_type = 'IOT')`;

async function reverse(c: DbConn, schema: string): Promise<ReverseRaw> {
  const q = <T>(sql: string) => c.query<T>(sql, [schema]);
  const tables = await q<{ t: string; cmt: string | null }>(`
    SELECT t.table_name AS "t", m.comments AS "cmt" FROM all_tables t
    LEFT JOIN all_tab_comments m ON m.owner = t.owner AND m.table_name = t.table_name
    WHERE t.owner = :1 AND ${LIVE} ORDER BY t.table_name`);
  const cols = await q<{ t: string; col: string; typ: string; clen: number; cused: string | null; prec: number | null; scale: number | null;
    nullable: string; def: string | null; virt: string; ident: string; gen: string | null; cmt: string | null }>(`
    SELECT c.table_name AS "t", c.column_name AS "col", c.data_type AS "typ", c.char_length AS "clen", c.char_used AS "cused",
      c.data_precision AS "prec", c.data_scale AS "scale", c.nullable AS "nullable", c.data_default AS "def",
      c.virtual_column AS "virt", c.identity_column AS "ident", i.generation_type AS "gen", m.comments AS "cmt"
    FROM all_tab_cols c
    LEFT JOIN all_tab_identity_cols i ON i.owner = c.owner AND i.table_name = c.table_name AND i.column_name = c.column_name
    LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
    WHERE c.owner = :1 AND c.hidden_column = 'NO' ORDER BY c.table_name, c.column_id`);
  const cons = await q<{ t: string; name: string; kind: string; cond: string | null; gen: string; del: string | null; defer: string | null;
    deferred: string | null; col: string | null; ft: string | null; fcol: string | null }>(`
    SELECT k.table_name AS "t", k.constraint_name AS "name", k.constraint_type AS "kind", k.search_condition AS "cond", k.generated AS "gen",
      k.delete_rule AS "del", k.deferrable AS "defer", k.deferred AS "deferred", cc.column_name AS "col", r.table_name AS "ft", rc.column_name AS "fcol"
    FROM all_constraints k
    LEFT JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
    LEFT JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name
    LEFT JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
    WHERE k.owner = :1 AND k.constraint_type IN ('P', 'U', 'R', 'C') AND k.table_name NOT LIKE 'BIN$%'
    ORDER BY k.table_name, k.constraint_name, cc.position`);
  // 제약이 만든 인덱스(PK, UNIQUE)와 LOB 인덱스는 빼고 직접 만든 인덱스만
  const indexes = await q<{ t: string; name: string; uniq: string; typ: string; col: string; expr: string | null }>(`
    SELECT i.table_name AS "t", i.index_name AS "name", i.uniqueness AS "uniq", i.index_type AS "typ", ic.column_name AS "col", e.column_expression AS "expr"
    FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
    LEFT JOIN all_ind_expressions e ON e.index_owner = i.owner AND e.index_name = i.index_name AND e.column_position = ic.column_position
    WHERE i.owner = :1 AND i.table_name NOT LIKE 'BIN$%' AND i.index_type <> 'LOB'
      AND NOT EXISTS (SELECT 1 FROM all_constraints k WHERE k.owner = i.owner AND k.index_name = i.index_name AND k.constraint_type IN ('P', 'U'))
    ORDER BY i.table_name, i.index_name, ic.column_position`);
  // IDENTITY 가 만든 시퀀스(ISEQ$$)는 뺀다. 시작값은 사전에 없어 다음 값(LAST_NUMBER)을 쓴다
  const seqs = await q<{ name: string; start: number; inc: number }>(`
    SELECT sequence_name AS "name", last_number AS "start", increment_by AS "inc" FROM all_sequences
    WHERE sequence_owner = :1 AND sequence_name NOT LIKE 'ISEQ$$%' ORDER BY sequence_name`);
  const others = await q<{ kind: string; name: string }>(`
    SELECT object_type AS "kind", object_name AS "name" FROM all_objects
    WHERE owner = :1 AND object_type IN ('VIEW', 'TRIGGER', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'MATERIALIZED VIEW') ORDER BY 1, 2`);

  const byName = new Map<string, Table>();
  for (const t of tables) byName.set(t.t, { id: '', name: t.t, comment: t.cmt ?? '', columns: [], pk: [], fks: [], uniques: [], indexes: [] });
  const warnings: string[] = [];
  for (const c of cols) {
    const t = byName.get(c.t);
    if (!t) continue; // 뷰 컬럼
    const col: Column = { name: c.col, type: typeText(c), notNull: c.nullable === 'N' };
    const def = c.def?.trim();
    if (c.ident === 'YES') col.identity = c.gen === 'ALWAYS' ? 'always' : 'default';
    else if (c.virt === 'YES' && def) col.generated = def;
    else if (def && def.toUpperCase() !== 'NULL') col.default = def; // DEFAULT NULL 로 지운 기본값은 글자 NULL 로 남는다
    if (c.cmt) col.comment = c.cmt;
    t.columns.push(col);
  }
  const group = <T extends { t: string; name: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(`${r.t}\u0000${r.name}`, [...(m.get(`${r.t}\u0000${r.name}`) ?? []), r]);
    return [...m.values()];
  };
  for (const g of group(cons)) {
    const t = byName.get(g[0].t);
    if (!t) continue;
    const k = g[0];
    if (k.kind === 'P') t.pk = g.map(x => x.col!);
    else if (k.kind === 'U') t.uniques.push({ name: k.name, columns: g.map(x => x.col!) });
    else if (k.kind === 'C') {
      // NOT NULL 도 CHECK 로 저장된다: 컬럼의 NN 표시로 이미 담았으니 뺀다
      if (!k.cond || /^"[^"]+" IS NOT NULL$/.test(k.cond.trim())) continue;
      (t.checks ??= []).push({ name: k.name, definition: `CHECK (${k.cond.trim()})` });
    } else {
      const fk: ForeignKey = { name: k.name, columns: g.map(x => x.col!), refTable: k.ft!, refColumns: g.map(x => x.fcol!) };
      if (k.del && FK_ACTION[k.del]) fk.onDelete = FK_ACTION[k.del];
      if (k.defer === 'DEFERRABLE') fk.deferrable = k.deferred === 'DEFERRED' ? 'deferred' : 'immediate';
      t.fks.push(fk);
    }
  }
  for (const g of group(indexes)) {
    const t = byName.get(g[0].t);
    if (!t) continue;
    if (!/^(NORMAL|FUNCTION-BASED NORMAL)$/.test(g[0].typ)) warnings.push(`인덱스 ${g[0].name}: ${g[0].typ} 정보는 모델에 담지 않았다`);
    t.indexes.push({ name: g[0].name, columns: g.map(x => x.expr?.trim() || x.col), unique: g[0].uniq === 'UNIQUE' });
  }
  const KIND: Record<string, string> = { VIEW: '뷰', TRIGGER: '트리거', PROCEDURE: '프로시저', FUNCTION: '함수', PACKAGE: '패키지', 'MATERIALIZED VIEW': '구체화 뷰' };
  for (const o of others) warnings.push(`${KIND[o.kind] ?? o.kind} ${o.name}: 모델에 담지 않는다`);
  return {
    tables: [...byName.values()],
    sequences: seqs.map(s => ({ name: s.name, start: Number(s.start), inc: Number(s.inc) })),
    functions: [],
    warnings,
  };
}

async function count(c: DbConn, schema: string) {
  const [r] = await c.query<{ tables: number; fks: number }>(`SELECT
    (SELECT COUNT(*) FROM all_tables t WHERE t.owner = :1 AND ${LIVE}) AS "tables",
    (SELECT COUNT(*) FROM all_constraints k WHERE k.owner = :2 AND k.constraint_type = 'R' AND k.table_name NOT LIKE 'BIN$%') AS "fks" FROM dual`, [schema, schema]);
  return { tables: Number(r.tables), fks: Number(r.fks) };
}

async function catalog(c: DbConn): Promise<SqlCatalog> {
  const rels = await c.query<{ sch: string; name: string; kind: string; cmt: string | null }>(`
    SELECT USER AS "sch", o.object_name AS "name", o.object_type AS "kind", m.comments AS "cmt" FROM user_objects o
    LEFT JOIN user_tab_comments m ON m.table_name = o.object_name
    WHERE o.object_type IN ('TABLE', 'VIEW') AND o.object_name NOT LIKE 'BIN$%' ORDER BY o.object_name`);
  const cols = await c.query<{ tbl: string; name: string; typ: string; clen: number; cused: string | null; prec: number | null; scale: number | null; cmt: string | null }>(`
    SELECT c.table_name AS "tbl", c.column_name AS "name", c.data_type AS "typ", c.char_length AS "clen", c.char_used AS "cused",
      c.data_precision AS "prec", c.data_scale AS "scale", m.comments AS "cmt"
    FROM user_tab_cols c LEFT JOIN user_col_comments m ON m.table_name = c.table_name AND m.column_name = c.column_name
    WHERE c.hidden_column = 'NO' ORDER BY c.table_name, c.column_id`);
  const fns = await c.query<{ name: string }>(`SELECT object_name AS "name" FROM user_objects WHERE object_type = 'FUNCTION' ORDER BY 1`);
  const byTable = new Map<string, SqlCatalog['tables'][number]>();
  const tables = rels.map(r => {
    const t = { name: r.name, schema: r.sch, kind: r.kind === 'VIEW' ? 'view' as const : 'table' as const, comment: r.cmt ?? '', columns: [] as SqlCatalog['tables'][number]['columns'] };
    byTable.set(r.name, t);
    return t;
  });
  for (const x of cols) byTable.get(x.tbl)?.columns.push({ name: x.name, type: typeText(x), comment: x.cmt ?? '' });
  return { dialect: 'oracle', tables, functions: fns.map(f => ({ name: f.name, args: '', returns: '' })) };
}

export const oracleAdapter: DbAdapter = {
  dialect: 'oracle',
  async connect(t: Target) {
    const c = await oracledb.getConnection({ user: t.user, password: t.password, connectString: `${t.host}:${t.port}/${t.database}`, connectTimeout: 10 });
    // 날짜를 글자로 받을 때의 모양 (DB 도구들이 흔히 쓰는 모양)
    await c.execute(`ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'`);
    return wrap(c);
  },
  isAuthError: e => (e as { errorNum?: number }).errorNum === 1017,
  errorInfo(e) {
    const err = e as Error & { errorNum?: number; offset?: number; code?: string };
    return { message: err.message, code: err.code ?? (err.errorNum ? `ORA-${String(err.errorNum).padStart(5, '0')}` : undefined), position: err.offset ? err.offset + 1 : undefined };
  },
  defaultSchema: t => (t.schema || t.user).toUpperCase(),
  reverse,
  count,
  catalog,
  async serverInfo(c) {
    const [v] = await c.query<{ db: string }>(`SELECT SYS_CONTEXT('USERENV', 'CON_NAME') AS "db" FROM dual`);
    return { database: v.db, version: `Oracle ${(c as OraConn).raw.oracleServerVersionString}` };
  },
  // 서버가 읽기 전용을 막지 못한다(DDL 이 트랜잭션을 끝낸다). 끝에 dbQuery 가 롤백한다. 시간 제한은 호출 시간 제한(callTimeout)
  async beginAiQuery(c, timeoutMs) {
    (c as OraConn).raw.callTimeout = Math.max(1000, Math.floor(timeoutMs));
  },
};
