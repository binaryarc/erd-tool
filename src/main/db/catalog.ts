// SQL 자동완성용 목록: 접속한 DB 의 테이블, 뷰, 컬럼, 함수 이름 (DBeaver 처럼 ERD 를 열지 않아도 쓰게)
// 읽기 전용 연결을 따로 잠깐 열어 읽는다. SQL 탭 연결(트랜잭션 중일 수 있음)은 건드리지 않는다.

import type { ConnRef, SqlCatalog } from '../../shared/ipc';
import { shortType } from '../../shared/model/pg-types';
import { connect, resolve } from './connect';

const USER_SCHEMAS = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'`;

export async function loadCatalog(ref: ConnRef): Promise<SqlCatalog> {
  const client = await connect(await resolve(ref), true);
  try {
    const rels = (await client.query(`
      select n.nspname sch, c.relname name, c.relkind kind, obj_description(c.oid, 'pg_class') cmt
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_SCHEMAS}
        and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
      order by 2`)).rows as { sch: string; name: string; kind: string; cmt: string | null }[];
    const cols = (await client.query(`
      select n.nspname sch, c.relname tbl, a.attname name, format_type(a.atttypid, a.atttypmod) typ, col_description(c.oid, a.attnum) cmt
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${USER_SCHEMAS}
      order by 1, 2, a.attnum`)).rows as { sch: string; tbl: string; name: string; typ: string; cmt: string | null }[];
    const fns = (await client.query(`
      select distinct p.proname name, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${USER_SCHEMAS} and p.prokind in ('f', 'a')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by 1`)).rows as { name: string; args: string; ret: string | null }[];

    const key = (s: string, t: string) => `${s}.${t}`;
    const byTable = new Map<string, SqlCatalog['tables'][number]>();
    const tables = rels.map(r => {
      const t = { name: r.name, schema: r.sch, kind: r.kind === 'v' || r.kind === 'm' ? 'view' as const : 'table' as const, comment: r.cmt ?? '', columns: [] as SqlCatalog['tables'][number]['columns'] };
      byTable.set(key(r.sch, r.name), t);
      return t;
    });
    for (const c of cols) byTable.get(key(c.sch, c.tbl))?.columns.push({ name: c.name, type: shortType(c.typ), comment: c.cmt ?? '' });
    return { tables, functions: fns.map(f => ({ name: f.name, args: f.args, returns: f.ret ?? '' })) };
  } finally {
    await client.end().catch(() => {});
  }
}
