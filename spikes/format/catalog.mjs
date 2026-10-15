// STEP 1 시험: test DB 구조(테이블, 컬럼, PK, FK, 코멘트)만 뽑아 catalog.json 으로 저장하고
// JSON 형식과 한 줄 표기 형식의 크기를 비교한다. 행 데이터는 읽지 않는다.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../jasypt/package.json', import.meta.url));
const pg = require('pg');

// 접속 정보는 jasypt 시험 스크립트와 같은 방식으로 얻는다 (환경변수 PG* 로 넘겨받음)
const client = new pg.Client();
await client.connect();
const q = async sql => (await client.query(sql)).rows;

const tables = await q(`select c.relname t, obj_description(c.oid,'pg_class') cmt
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind='r' and n.nspname='public' order by 1`);
const cols = await q(`select c.relname t, a.attname col, format_type(a.atttypid,a.atttypmod) typ, a.attnotnull nn,
  pg_get_expr(d.adbin,d.adrelid) def, col_description(c.oid,a.attnum) cmt, a.attnum
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
  where c.relkind='r' and n.nspname='public' order by 1, a.attnum`);
const keys = await q(`select c.relname t, k.contype, k.conname, f.relname ft,
  (select array_agg(a.attname order by x.o) from unnest(k.conkey) with ordinality x(n,o) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.n) cols,
  (select array_agg(a.attname order by x.o) from unnest(k.confkey) with ordinality x(n,o) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.n) fcols
  from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_class f on f.oid=k.confrelid
  where n.nspname='public' and k.contype in ('p','f') order by 1,3`);
await client.end();

const model = { tables: {} };
for (const t of tables) model.tables[t.t] = { comment: t.cmt ?? '', columns: {}, pk: [], fks: [] };
for (const c of cols) model.tables[c.t].columns[c.col] = { type: c.typ, notNull: c.nn, default: c.def, comment: c.cmt ?? '' };
for (const k of keys) {
  if (k.contype === 'p') model.tables[k.t].pk = k.cols;
  else model.tables[k.t].fks.push({ name: k.conname, columns: k.cols, refTable: k.ft, refColumns: k.fcols });
}
fs.writeFileSync(new URL('./catalog.json', import.meta.url), JSON.stringify(model, null, 2));

// 한 줄 표기 (설계 문서 10-2)
const COMMON = ['reg_id', 'reg_dt', 'mod_id', 'mod_dt'];
const lines = [];
let commonAll = 0;
for (const [name, t] of Object.entries(model.tables)) {
  const names = Object.keys(t.columns);
  const hasCommon = COMMON.every(c => names.includes(c));
  if (hasCommon) commonAll++;
  lines.push(`${name} ${t.comment}${hasCommon ? ' +공통4' : ''}`);
  for (const [cn, c] of Object.entries(t.columns)) {
    if (hasCommon && COMMON.includes(cn)) continue;
    const fk = t.fks.find(f => f.columns.length === 1 && f.columns[0] === cn);
    lines.push('  ' + [cn, c.type.replace('character varying', 'varchar').replace('timestamp without time zone', 'timestamp'),
      t.pk.includes(cn) ? 'PK' : '', fk ? `FK>${fk.refTable}.${fk.refColumns[0]}` : '',
      c.notNull && !t.pk.includes(cn) ? 'NN' : '', c.default != null ? '=' + c.default : '', c.comment ? '#' + c.comment : '']
      .filter(Boolean).join(' '));
  }
  for (const f of t.fks.filter(f => f.columns.length > 1)) lines.push(`  FK(${f.columns}) > ${f.refTable}(${f.refColumns})`);
}
const line = lines.join('\n');
fs.writeFileSync(new URL('./catalog.lines.txt', import.meta.url), line);

const pretty = JSON.stringify(model, null, 2), compact = JSON.stringify(model);
console.log(`테이블 ${tables.length}, 컬럼 ${cols.length}, PK ${keys.filter(k => k.contype === 'p').length}, FK ${keys.filter(k => k.contype === 'f').length}, 공통4 보유 테이블 ${commonAll}`);
console.log(`JSON(들여쓰기) ${pretty.length}자, JSON(압축) ${compact.length}자, 한 줄 표기 ${line.length}자`);
