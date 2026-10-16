// SQL Server 어댑터 (STEP 9). 드라이버 mssql(tedious).
// - 연결 하나만 쓰도록 풀 크기를 1 로 둔다: BEGIN TRANSACTION 은 연결에 남으므로 탭의 모든 문장이 같은 연결로 가야 한다
// - 사용자 문장은 배치로 보낸다(sp_executesql 이 아니라서 SET, DECLARE 가 그 배치 그대로 돈다). 결과는 스트림을 멈췄다 풀며 1,000행씩
// - 서버가 읽기 전용을 막지 못한다. 읽기 전용 접속은 DB 계정 권한으로 막는다(사용자 결정 2026-10-16)
// - 한 문장 실패가 트랜잭션 전체를 망가뜨릴 수 있다(XACT_STATE() = -1). 그때는 전체를 롤백하고 세션에 알린다(inTx)

import mssql from 'mssql';
import type { SqlCatalog } from '../../../shared/ipc';
import type { Column, FkAction, ForeignKey, Table } from '../../../shared/model/types';
import { firstWord, type CursorRead, type DbAdapter, type DbConn, type ReverseRaw, type RowCursor, type Target } from './types';

/** 값은 DB 가 보여주는 글자에 가깝게: 날짜는 저장된 값 그대로(UTC 로 읽음), 이진은 0x16진수 */
function cell(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/Z$/, '').replace(/\.000$/, '');
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex').toUpperCase();
  return v;
}

interface MsConn extends DbConn {
  /** AI 조회 시간 제한 (ms). 0 이면 없음 */
  timeoutMs: number;
}

function wrap(pool: mssql.ConnectionPool): MsConn {
  // 요청별 시간 제한(두 번째 인자)은 mssql 12 에 있으나 타입 정의(@types/mssql 12.3)에 없다
  const Req = mssql.Request as unknown as new (p: mssql.ConnectionPool, o?: { requestTimeout?: number }) => mssql.Request;
  const request = (timeoutMs = 0) => new Req(pool, timeoutMs ? { requestTimeout: timeoutMs } : undefined);
  const conn: MsConn = {
    timeoutMs: 0,
    async query<T>(sql: string, params: unknown[] = []) {
      const r = request();
      params.forEach((v, i) => r.input(`p${i + 1}`, v));
      return ((await r.query(sql)).recordset ?? []) as T[];
    },
    exec: async sql => { await request().batch(sql); },
    cursor(sql): RowCursor {
      const req = request(conn.timeoutMs);
      req.stream = true;
      req.arrayRowMode = true;
      let sets = 0, fields: string[] | null = null, affected = 0, want = 0, done = false, err: unknown = null;
      const buf: unknown[][] = [];
      let wake: (() => void) | null = null;
      const poke = () => { const w = wake; wake = null; w?.(); };
      // 첫 결과 집합만 보여준다 (여러 SELECT 를 한 배치로 보내면 나머지는 버린다)
      req.on('recordset', (cols: { name: string }[]) => { if (++sets === 1) fields = cols.map(c => c.name); });
      req.on('row', (row: unknown[]) => {
        if (sets !== 1) return;
        buf.push(row.map(cell));
        if (buf.length >= want) { req.pause(); poke(); }
      });
      req.on('rowsaffected', (n: number) => { affected += n; });
      req.on('error', (e: unknown) => { err ??= e; });
      req.on('done', () => { done = true; poke(); });
      void Promise.resolve(req.batch(sql)).catch(() => {}); // 오류는 error 이벤트로 받는다
      return {
        async read(n): Promise<CursorRead> {
          want = n;
          while (buf.length < n && !done) await new Promise<void>(ok => { wake = ok; req.resume(); });
          if (err) throw err;
          const rows = buf.splice(0, n);
          return { rows, fields: fields ?? [], command: firstWord(sql), rowCount: fields ? null : affected };
        },
        async close() {
          if (done) return;
          req.cancel();
          req.resume();
          await new Promise<void>(ok => { wake = ok; setTimeout(ok, 5000); });
        },
      };
    },
    begin: () => conn.exec('BEGIN TRANSACTION'),
    commit: () => conn.exec('IF @@TRANCOUNT > 0 COMMIT TRANSACTION'),
    rollback: () => conn.exec('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'),
    savepoint: n => conn.exec(`SAVE TRANSACTION ${n}`),
    // 트랜잭션이 망가졌으면(XACT_STATE() = -1) savepoint 로 못 돌아가 전체를 롤백한다
    rollbackTo: n => conn.exec(`IF XACT_STATE() = -1 ROLLBACK TRANSACTION ELSE IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION ${n}`),
    release: async () => {},
    setReadOnly: async () => {},
    inTx: async () => ((await conn.query<{ n: number }>('SELECT @@TRANCOUNT n'))[0]?.n ?? 0) > 0,
    close: async () => { await pool.close().catch(() => {}); },
  };
  return conn;
}

const FK_ACTION: Record<number, FkAction | undefined> = { 1: 'cascade', 2: 'set null', 3: 'set default' };

/** sys.columns → 타입 글자 (SSMS 와 같은 모양, 소문자) */
function typeText(c: { typ: string; len: number; prec: number; scale: number }): string {
  const t = c.typ.toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${c.len === -1 ? 'max' : c.len})`;
  if (['nvarchar', 'nchar'].includes(t)) return `${t}(${c.len === -1 ? 'max' : c.len / 2})`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${c.prec},${c.scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(t)) return `${t}(${c.scale})`;
  return t;
}

/** 계산식은 sys.computed_columns 가 바깥 괄호를 붙여 준다. DDL 이 다시 괄호를 씌우므로 한 겹 벗긴다 */
function stripParens(s: string): string {
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0 && i < s.length - 1) return s;
  }
  return s.slice(1, -1);
}

const COMMENT = `ep.class = 1 AND ep.name = 'MS_Description'`;

async function reverse(c: DbConn, schema: string): Promise<ReverseRaw> {
  const q = <T>(sql: string) => c.query<T>(sql, [schema]);
  const tables = await q<{ t: string; cmt: string | null }>(`
    SELECT t.name t, CAST(ep.value AS nvarchar(max)) cmt FROM sys.tables t
    LEFT JOIN sys.extended_properties ep ON ${COMMENT} AND ep.major_id = t.object_id AND ep.minor_id = 0
    WHERE SCHEMA_NAME(t.schema_id) = @p1 AND t.is_ms_shipped = 0 ORDER BY t.name`);
  const cols = await q<{ t: string; col: string; typ: string; len: number; prec: number; scale: number; nullable: boolean; ident: boolean;
    seed: number | null; inc: number | null; def: string | null; gen: string | null; persisted: boolean | null; cmt: string | null }>(`
    SELECT t.name t, c.name col, ty.name typ, c.max_length len, c.precision prec, c.scale scale, c.is_nullable nullable, c.is_identity ident,
      CAST(ic.seed_value AS bigint) seed, CAST(ic.increment_value AS bigint) inc, dc.definition def, cc.definition gen, cc.is_persisted persisted,
      CAST(ep.value AS nvarchar(max)) cmt
    FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
    LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
    LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    LEFT JOIN sys.extended_properties ep ON ${COMMENT} AND ep.major_id = c.object_id AND ep.minor_id = c.column_id
    WHERE SCHEMA_NAME(t.schema_id) = @p1 AND t.is_ms_shipped = 0 ORDER BY t.name, c.column_id`);
  const keys = await q<{ t: string; name: string; kind: string; col: string }>(`
    SELECT t.name t, k.name name, k.type kind, c.name col FROM sys.key_constraints k
    JOIN sys.tables t ON t.object_id = k.parent_object_id
    JOIN sys.index_columns ic ON ic.object_id = k.parent_object_id AND ic.index_id = k.unique_index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE SCHEMA_NAME(t.schema_id) = @p1 ORDER BY t.name, k.name, ic.key_ordinal`);
  const fks = await q<{ t: string; name: string; ft: string; del: number; upd: number; col: string; fcol: string }>(`
    SELECT t.name t, f.name name, rt.name ft, f.delete_referential_action del, f.update_referential_action upd, pc.name col, rc.name fcol
    FROM sys.foreign_keys f JOIN sys.tables t ON t.object_id = f.parent_object_id
    JOIN sys.tables rt ON rt.object_id = f.referenced_object_id
    JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id
    JOIN sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id
    WHERE SCHEMA_NAME(t.schema_id) = @p1 ORDER BY t.name, f.name, fc.constraint_column_id`);
  const checks = await q<{ t: string; name: string; def: string }>(`
    SELECT t.name t, k.name name, k.definition def FROM sys.check_constraints k JOIN sys.tables t ON t.object_id = k.parent_object_id
    WHERE SCHEMA_NAME(t.schema_id) = @p1 ORDER BY t.name, k.name`);
  // 제약이 만든 인덱스(PK, UNIQUE)와 힙은 빼고 직접 만든 인덱스만. 포함 컬럼, 필터, 내림차순은 경고
  const indexes = await q<{ t: string; name: string; uniq: boolean; filt: boolean; col: string; incl: boolean; descd: boolean }>(`
    SELECT t.name t, i.name name, i.is_unique uniq, i.has_filter filt, c.name col, ic.is_included_column incl, ic.is_descending_key descd
    FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE SCHEMA_NAME(t.schema_id) = @p1 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.type IN (1, 2) AND i.is_hypothetical = 0
    ORDER BY t.name, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id`);
  const seqs = await q<{ name: string; start: number; inc: number }>(`
    SELECT name, CAST(start_value AS bigint) start, CAST(increment AS bigint) inc FROM sys.sequences WHERE SCHEMA_NAME(schema_id) = @p1 ORDER BY name`);
  const others = await q<{ name: string; kind: string; t: string | null }>(`
    SELECT o.name name, o.type kind, OBJECT_NAME(o.parent_object_id) t FROM sys.objects o
    WHERE SCHEMA_NAME(o.schema_id) = @p1 AND o.is_ms_shipped = 0 AND o.type IN ('V', 'TR', 'P', 'FN', 'IF', 'TF') ORDER BY o.type, o.name`);

  const byName = new Map<string, Table>();
  for (const t of tables) byName.set(t.t, { id: '', name: t.t, comment: t.cmt ?? '', columns: [], pk: [], fks: [], uniques: [], indexes: [] });
  const warnings: string[] = [];
  for (const c of cols) {
    const col: Column = { name: c.col, type: typeText(c), notNull: !c.nullable };
    if (c.ident) {
      col.identity = 'always';
      if (Number(c.seed) !== 1 || Number(c.inc) !== 1) { col.identityStart = Number(c.seed); col.identityStep = Number(c.inc); }
    }
    if (c.gen !== null) {
      col.generated = stripParens(c.gen);
      if (!c.persisted) warnings.push(`컬럼 ${c.t}.${c.col}: 저장하지 않는 계산 컬럼입니다. 다시 만들면 PERSISTED 가 됩니다`);
    } else if (c.def !== null) col.default = c.def;
    if (c.cmt) col.comment = c.cmt;
    byName.get(c.t)?.columns.push(col);
  }
  const group = <T extends { t: string; name: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(`${r.t}\u0000${r.name}`, [...(m.get(`${r.t}\u0000${r.name}`) ?? []), r]);
    return [...m.values()];
  };
  for (const g of group(keys)) {
    const t = byName.get(g[0].t);
    if (!t) continue;
    if (g[0].kind.trim() === 'PK') t.pk = g.map(x => x.col);
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
  for (const k of checks) (byName.get(k.t)!.checks ??= []).push({ name: k.name, definition: `CHECK ${k.def}` });
  for (const g of group(indexes)) {
    const keyCols = g.filter(x => !x.incl);
    const notes = [g.some(x => x.incl) && '포함 컬럼(INCLUDE)', g[0].filt && '필터', g.some(x => x.descd) && '내림차순'].filter(Boolean);
    if (notes.length) warnings.push(`인덱스 ${g[0].name}: ${notes.join(', ')} 정보는 모델에 담지 않았습니다`);
    byName.get(g[0].t)?.indexes.push({ name: g[0].name, columns: keyCols.map(x => x.col), unique: g[0].uniq });
  }
  const KIND: Record<string, string> = { V: '뷰', TR: '트리거', P: '프로시저', FN: '함수', IF: '함수', TF: '함수' };
  for (const o of others) warnings.push(`${KIND[o.kind.trim()]} ${o.t && o.kind.trim() === 'TR' ? `${o.t}.` : ''}${o.name}: 모델에 담지 않습니다`);
  return {
    tables: [...byName.values()],
    sequences: seqs.map(s => ({ name: s.name, start: Number(s.start), inc: Number(s.inc) })),
    functions: [],
    warnings,
  };
}

async function count(c: DbConn, schema: string) {
  const [r] = await c.query<{ tables: number; fks: number }>(`SELECT
    (SELECT COUNT(*) FROM sys.tables WHERE SCHEMA_NAME(schema_id) = @p1 AND is_ms_shipped = 0) tables,
    (SELECT COUNT(*) FROM sys.foreign_keys WHERE SCHEMA_NAME(schema_id) = @p1) fks`, [schema]);
  return r;
}

async function catalog(c: DbConn): Promise<SqlCatalog> {
  const rels = await c.query<{ sch: string; name: string; kind: string; cmt: string | null }>(`
    SELECT SCHEMA_NAME(o.schema_id) sch, o.name name, o.type kind, CAST(ep.value AS nvarchar(max)) cmt FROM sys.objects o
    LEFT JOIN sys.extended_properties ep ON ${COMMENT} AND ep.major_id = o.object_id AND ep.minor_id = 0
    WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY o.name`);
  const cols = await c.query<{ sch: string; tbl: string; name: string; typ: string; len: number; prec: number; scale: number; cmt: string | null }>(`
    SELECT SCHEMA_NAME(o.schema_id) sch, o.name tbl, c.name name, ty.name typ, c.max_length len, c.precision prec, c.scale scale,
      CAST(ep.value AS nvarchar(max)) cmt
    FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN sys.extended_properties ep ON ${COMMENT} AND ep.major_id = c.object_id AND ep.minor_id = c.column_id
    WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY 1, 2, c.column_id`);
  const fns = await c.query<{ name: string }>(`SELECT DISTINCT name FROM sys.objects WHERE type IN ('FN', 'IF', 'TF') AND is_ms_shipped = 0 ORDER BY name`);
  const byTable = new Map<string, SqlCatalog['tables'][number]>();
  const tables = rels.map(r => {
    const t = { name: r.name, schema: r.sch, kind: r.kind.trim() === 'V' ? 'view' as const : 'table' as const, comment: r.cmt ?? '', columns: [] as SqlCatalog['tables'][number]['columns'] };
    byTable.set(`${r.sch}.${r.name}`, t);
    return t;
  });
  for (const x of cols) byTable.get(`${x.sch}.${x.tbl}`)?.columns.push({ name: x.name, type: typeText(x), comment: x.cmt ?? '' });
  return { dialect: 'sqlserver', tables, functions: fns.map(f => ({ name: f.name, args: '', returns: '' })) };
}

export const mssqlAdapter: DbAdapter = {
  dialect: 'sqlserver',
  async connect(t: Target) {
    const pool = new mssql.ConnectionPool({
      server: t.host, port: t.port, database: t.database, user: t.user, password: t.password,
      connectionTimeout: 10_000, requestTimeout: 0,
      // 연결 하나를 계속 쓴다 (트랜잭션이 연결에 남는다). 쉬는 동안 닫히지 않게 한다
      pool: { min: 1, max: 1, idleTimeoutMillis: 2 ** 31 - 1 },
      options: { encrypt: true, trustServerCertificate: !!t.trustCert, appName: 'erd-tool' },
    });
    pool.on('error', () => {});
    await pool.connect();
    return wrap(pool);
  },
  isAuthError: e => (e as { code?: string }).code === 'ELOGIN',
  errorInfo(e) {
    const err = e as Error & { number?: number; code?: string };
    return { message: err.message, code: err.number !== undefined ? String(err.number) : err.code };
  },
  defaultSchema: t => t.schema || 'dbo',
  reverse,
  count,
  catalog,
  async serverInfo(c) {
    const [v] = await c.query<{ db: string; ver: string }>('SELECT DB_NAME() db, @@VERSION ver');
    return { database: v.db, version: String(v.ver).split('\n')[0].trim() };
  },
  // 서버가 읽기 전용을 막지 못한다: 트랜잭션 안에서 실행하고 dbQuery 가 끝에 롤백한다. 시간 제한은 요청마다 건다
  async beginAiQuery(c, timeoutMs) {
    (c as MsConn).timeoutMs = Math.max(1000, Math.floor(timeoutMs));
    await c.begin();
  },
};
