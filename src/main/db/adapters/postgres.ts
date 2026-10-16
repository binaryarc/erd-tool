// PostgreSQL 어댑터 (STEP 9 전에는 connect.ts, session.ts, catalog.ts, pg-reverse.ts, mcp/db-query.ts 에 있던 코드).
// 읽기 전용은 DB 서버가 막는다(default_transaction_read_only). 커서는 pg-cursor (확장 프로토콜이라 한 번에 문장 하나).
// 카탈로그 → 스키마 모델 (설계 6-1). 행 데이터는 읽지 않는다.
// 컬럼 목록은 name[] 대신 구분자로 이어 받는다 (pg 가 name[] 를 '{a,b}' 문자열로 돌려줌, STEP 2 실측).

import pg from 'pg';
import Cursor from 'pg-cursor';
import { shortType } from '../../../shared/dialect/postgresql';
import type { SqlCatalog } from '../../../shared/ipc';
import type { Column, FkAction, ForeignKey, FunctionDef, Table } from '../../../shared/model/types';
import type { CursorRead, DbAdapter, DbConn, ReverseRaw, RowCursor, Target } from './types';

// DB 도구라 값은 DB 가 준 글자 그대로 보여준다 (날짜, numeric, json, bytea, 배열). 숫자와 참거짓만 바꾼다
const KEEP_PARSED = new Set([16, 21, 23, 26, 700, 701]); // bool, int2, int4, oid, float4, float8
const rawTypes = {
  getTypeParser: (oid: number, format?: string) =>
    KEEP_PARSED.has(oid) ? pg.types.getTypeParser(oid, format as 'text') : (v: string) => v,
};

function readCursor(cursor: Cursor, n: number): Promise<CursorRead> {
  return new Promise((ok, fail) => cursor.read(n, (err, rows, result) => (err ? fail(err) : ok({
    rows: rows as unknown[][], fields: (result.fields ?? []).map(f => f.name), command: result.command ?? '', rowCount: result.rowCount ?? null,
  }))));
}

function wrap(client: pg.Client): DbConn {
  return {
    query: async <T>(sql: string, params?: unknown[]) => (await client.query({ text: sql, values: params })).rows as T[],
    exec: async sql => { await client.query(sql); },
    cursor(sql): RowCursor {
      const cursor = client.query(new Cursor(sql, undefined, { rowMode: 'array', types: rawTypes }));
      // pg-cursor 는 오류 뒤 close() 가 끝나지 않는다(더 받기 오류 때 다음 실행이 멈췄다, 2026-10-16). 오류가 난 커서는 닫지 않고 버린다
      let failed = false;
      return {
        read: n => readCursor(cursor, n).catch(e => { failed = true; throw e; }),
        close: async () => { if (!failed) await cursor.close().catch(() => {}); },
      };
    },
    begin: async () => { await client.query('BEGIN'); },
    commit: async () => { await client.query('COMMIT'); },
    rollback: async () => { await client.query('ROLLBACK'); },
    savepoint: async n => { await client.query(`SAVEPOINT ${n}`); },
    rollbackTo: async n => { await client.query(`ROLLBACK TO SAVEPOINT ${n}`); },
    release: async n => { await client.query(`RELEASE SAVEPOINT ${n}`); },
    setReadOnly: async on => { await client.query(`set default_transaction_read_only = ${on ? 'on' : 'off'}`); },
    close: async () => { await client.end().catch(() => {}); },
  };
}

const SEP = '\u001f';

/** pg_constraint.confdeltype, confupdtype → 모델 값 (a = NO ACTION 은 적지 않는다) */
const FK_ACTION: Record<string, FkAction | undefined> = { r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };

/** 생성식은 pg_get_expr 가 바깥 괄호를 붙여 준다 ((qty * 2)). DDL 에 다시 괄호를 씌우므로 한 겹 벗긴다 */
function stripParens(s: string): string {
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0 && i < s.length - 1) return s; // 첫 괄호가 끝보다 먼저 닫힌다: (a) + (b)
  }
  return s.slice(1, -1);
}

async function reverse(c: DbConn, schema: string): Promise<ReverseRaw> {
  const q = <T>(sql: string): Promise<T[]> => c.query<T>(sql, [schema]);

  const tables = await q<{ t: string; cmt: string | null }>(`
    select c.relname t, obj_description(c.oid, 'pg_class') cmt
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = $1 order by 1`);
  // attidentity: a(ALWAYS), d(BY DEFAULT). attgenerated: s(STORED) 면 pg_attrdef 의 식은 기본값이 아니라 생성식이다
  const cols = await q<{ t: string; col: string; typ: string; nn: boolean; def: string | null; cmt: string | null; ident: string; gen: string }>(`
    select c.relname t, a.attname col, format_type(a.atttypid, a.atttypmod) typ, a.attnotnull nn,
           pg_get_expr(d.adbin, d.adrelid) def, col_description(c.oid, a.attnum) cmt, a.attidentity::text ident, a.attgenerated::text gen
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where c.relkind in ('r', 'p') and n.nspname = $1 order by 1, a.attnum`);
  const keys = await q<{ t: string; kind: string; name: string; ft: string | null; cols: string; fcols: string | null; def: string; del: string; upd: string; defer: boolean; deferred: boolean }>(`
    select c.relname t, k.contype kind, k.conname name, f.relname ft, pg_get_constraintdef(k.oid) def,
      k.confdeltype::text del, k.confupdtype::text upd, k.condeferrable defer, k.condeferred deferred,
      array_to_string(array(select a.attname from unnest(k.conkey) with ordinality x(n, o)
        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n order by x.o), '${SEP}') cols,
      array_to_string(array(select a.attname from unnest(k.confkey) with ordinality x(n, o)
        join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.n order by x.o), '${SEP}') fcols
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_class f on f.oid = k.confrelid
    where n.nspname = $1 and k.contype in ('p', 'f', 'u', 'c', 'x') order by 1, 3`);
  // 제약이 만든 인덱스(PK, UNIQUE)는 빼고 직접 만든 인덱스만
  const indexes = await q<{ t: string; name: string; uniq: boolean; cols: string; am: string; partial: boolean }>(`
    select t.relname t, ic.relname name, i.indisunique uniq, am.amname am, (i.indpred is not null) partial,
      array_to_string(array(select pg_get_indexdef(i.indexrelid, k, true) from generate_series(1, i.indnkeyatts) k order by k), '${SEP}') cols
    from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace join pg_am am on am.oid = ic.relam
    where n.nspname = $1 and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
    order by 1, 2`);
  // identity 컬럼이 만든 시퀀스(내부 의존 deptype i)는 뺀다. 컬럼의 IDENTITY 표시로 DB 가 다시 만든다
  const seqs = await q<{ name: string; start: string; inc: string }>(`
    select c.relname name, s.seqstart::text start, s.seqincrement::text inc
    from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'i')
    order by 1`);
  const triggers = await q<{ t: string; name: string }>(`
    select c.relname t, g.tgname name from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and not g.tgisinternal order by 1, 2`);
  // 확장 모듈이 만든 함수는 뺀다. 집계 함수는 pg_get_functiondef 로 못 읽어 경고로 남긴다
  const funcs = await q<{ name: string; args: string; kind: string; def: string | null }>(`
    select p.proname name, pg_get_function_identity_arguments(p.oid) args, p.prokind kind,
      case when p.prokind in ('f', 'p') then pg_get_functiondef(p.oid) end def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1 and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    order by 1, 2`);
  const views = await q<{ name: string }>(`
    select c.relname name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm') and n.nspname = $1
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
    order by 1`);

  const byName = new Map<string, Table>();
  for (const t of tables) {
    byName.set(t.t, { id: '', name: t.t, comment: t.cmt ?? '', columns: [], pk: [], fks: [], uniques: [], indexes: [] });
  }
  for (const c of cols) {
    const col: Column = { name: c.col, type: shortType(c.typ), notNull: c.nn };
    if (c.ident === 'a' || c.ident === 'd') col.identity = c.ident === 'a' ? 'always' : 'default';
    if (c.gen === 's' && c.def !== null) col.generated = stripParens(c.def);
    else if (c.def !== null) col.default = c.def;
    if (c.cmt) col.comment = c.cmt;
    byName.get(c.t)!.columns.push(col);
  }
  const split = (s: string | null) => (s ? s.split(SEP) : []);
  const warnings: string[] = [];
  for (const k of keys) {
    const t = byName.get(k.t);
    if (!t) continue;
    if (k.kind === 'p') t.pk = split(k.cols);
    else if (k.kind === 'u') t.uniques.push({ name: k.name, columns: split(k.cols) });
    else if (k.kind === 'c') (t.checks ??= []).push({ name: k.name, definition: k.def });
    else if (k.kind === 'x') warnings.push(`제약 ${k.t}.${k.name}: 배제(EXCLUDE) 제약은 모델에 담지 않았습니다`);
    else {
      const fk: ForeignKey = { name: k.name, columns: split(k.cols), refTable: k.ft!, refColumns: split(k.fcols) };
      // 참조 동작과 DEFERRABLE (2026-10-16 추가). a(NO ACTION)와 바로 검사는 적지 않는다
      if (FK_ACTION[k.del]) fk.onDelete = FK_ACTION[k.del];
      if (FK_ACTION[k.upd]) fk.onUpdate = FK_ACTION[k.upd];
      if (k.defer) fk.deferrable = k.deferred ? 'deferred' : 'immediate';
      t.fks.push(fk);
    }
  }
  for (const g of triggers) warnings.push(`트리거 ${g.t}.${g.name}: 모델에 담지 않습니다`);
  for (const i of indexes) {
    if (i.am !== 'btree' || i.partial) warnings.push(`인덱스 ${i.name}: ${i.am}${i.partial ? ', 부분 인덱스' : ''} 정보는 모델에 담지 않았습니다`);
    byName.get(i.t)?.indexes.push({ name: i.name, columns: split(i.cols), unique: i.uniq });
  }
  for (const v of views) warnings.push(`뷰 ${v.name}: 아직 모델에 담지 않습니다`);
  const functions: FunctionDef[] = [];
  for (const f of funcs) {
    if (f.def === null) { warnings.push(`함수 ${f.name}(${f.args}): 집계 함수라 담지 않았습니다`); continue; }
    functions.push({ name: f.name, args: f.args, definition: f.def.replace(/\r\n/g, '\n').replace(/\s+$/, '') });
  }

  return {
    tables: [...byName.values()],
    sequences: seqs.map(s => ({ name: s.name, start: Number(s.start), inc: Number(s.inc) })),
    functions,
    warnings,
  };
}

/** 직접 조회한 테이블 수, FK 수 (완료 기준 대조용) */
async function count(c: DbConn, schema: string): Promise<{ tables: number; fks: number }> {
  const [r] = await c.query<{ tables: number; fks: number }>(`select
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname = $1)::int tables,
      (select count(*) from pg_constraint k join pg_namespace n on n.oid = k.connamespace where k.contype = 'f' and n.nspname = $1)::int fks`, [schema]);
  return r;
}

const USER_SCHEMAS = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'`;

async function catalog(client: DbConn): Promise<SqlCatalog> {
  {
    const rels = (await client.query<{ sch: string; name: string; kind: string; cmt: string | null }>(`
      select n.nspname sch, c.relname name, c.relkind kind, obj_description(c.oid, 'pg_class') cmt
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_SCHEMAS}
        and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
      order by 2`));
    const cols = (await client.query<{ sch: string; tbl: string; name: string; typ: string; cmt: string | null }>(`
      select n.nspname sch, c.relname tbl, a.attname name, format_type(a.atttypid, a.atttypmod) typ, col_description(c.oid, a.attnum) cmt
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_SCHEMAS}
      order by 1, 2, a.attnum`));
    const fns = (await client.query<{ name: string; args: string; ret: string | null }>(`
      select distinct p.proname name, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${USER_SCHEMAS} and p.prokind in ('f', 'a')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by 1`));

    const key = (s: string, t: string) => `${s}.${t}`;
    const byTable = new Map<string, SqlCatalog['tables'][number]>();
    const tables = rels.map(r => {
      const t = { name: r.name, schema: r.sch, kind: r.kind === 'v' || r.kind === 'm' ? 'view' as const : 'table' as const, comment: r.cmt ?? '', columns: [] as SqlCatalog['tables'][number]['columns'] };
      byTable.set(key(r.sch, r.name), t);
      return t;
    });
    for (const c of cols) byTable.get(key(c.sch, c.tbl))?.columns.push({ name: c.name, type: shortType(c.typ), comment: c.cmt ?? '' });
    return { dialect: 'postgresql', tables, functions: fns.map(f => ({ name: f.name, args: f.args, returns: f.ret ?? '' })) };
  }
}

export const postgresAdapter: DbAdapter = {
  dialect: 'postgresql',
  /** readOnly 면 이 연결의 모든 트랜잭션을 DB 서버가 읽기 전용으로 막는다 */
  async connect(t: Target, readOnly: boolean) {
    const client = new pg.Client({
      host: t.host, port: t.port, database: t.database, user: t.user, password: t.password,
      connectionTimeoutMillis: 10_000, application_name: 'erd-tool',
    });
    await client.connect();
    const c = wrap(client);
    if (readOnly) await c.setReadOnly(true);
    return c;
  },
  isAuthError: e => (e as { code?: string }).code === '28P01',
  errorInfo(e) {
    const err = e as Error & { position?: string; code?: string };
    return { message: err.message, code: err.code, position: err.position ? Number(err.position) : undefined };
  },
  defaultSchema: t => t.schema || 'public',
  reverse,
  count,
  catalog,
  async serverInfo(c) {
    const [v] = await c.query<{ db: string; ver: string }>('select current_database() db, version() ver');
    return { database: v.db, version: String(v.ver).split(',')[0] };
  },
  // 세 겹으로 막는다: 연결의 default_transaction_read_only, BEGIN READ ONLY(첫 조회를 먼저 해 읽기-쓰기 전환도 막음), 확장 프로토콜(pg-cursor)이라 한 번에 문장 하나
  async beginAiQuery(c, timeoutMs) {
    await c.exec(`set statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
    await c.exec('BEGIN READ ONLY');
    await c.exec('SELECT 1'); // 첫 조회 뒤에는 트랜잭션을 읽기-쓰기로 바꿀 수 없다 (SET TRANSACTION READ WRITE 차단)
  },
};
