// PostgreSQL 규칙 (STEP 9 전에는 sql/alter.ts, model/pg-types.ts, sql/complete.ts 에 흩어져 있던 것)
// flyway 선택 사항(STEP 7): 스키마 접두어(모델의 스키마, 없으면 public)를 붙이고 여러 번 실행해도 안전하게 쓴다
//   (IF NOT EXISTS, IF EXISTS, 제약 추가는 pg_constraint 를 확인하는 DO 블록).

import { isProcedure } from '../model/diff';
import { fkOptions, identityArgs } from '../model/erd-format';
import type { Column, Table } from '../model/types';
import { PG_TEXT } from '../sql/text';
import type { DdlOptions, DdlWriter, DialectRules } from './index';

const RESERVED = new Set(['user', 'order', 'group', 'table', 'select', 'from', 'where', 'desc', 'asc', 'limit', 'offset', 'check', 'default', 'primary', 'references', 'column', 'end', 'type', 'key']);
/** 식별자: 소문자, 숫자, _ 이고 예약어가 아니면 그대로, 아니면 큰따옴표 */
const q = (n: string) => (/^[a-z_][a-z0-9_]*$/.test(n) && !RESERVED.has(n) ? n : `"${n.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const cols = (xs: string[]) => xs.map(x => (/^[a-z_][a-z0-9_]*$/i.test(x) ? q(x) : x)).join(', '); // 식 인덱스는 그대로

// PostgreSQL 이 돌려주는 긴 타입 이름을 같은 뜻의 짧은 이름으로 바꾼다 (정보 손실 없음)
const TYPE_ALIASES: [RegExp, string][] = [
  [/^character varying/, 'varchar'],
  [/^character\b/, 'char'],
  [/^timestamp without time zone/, 'timestamp'],
  [/^timestamp with time zone/, 'timestamptz'],
  [/^time without time zone/, 'time'],
  [/^time with time zone/, 'timetz'],
];
export const shortType = (t: string): string => TYPE_ALIASES.reduce((s, [re, to]) => s.replace(re, to), t);

/** IDENTITY 절. 시작값, 증가값이 (1, 1) 이 아니면 시퀀스 옵션을 붙인다 */
const identityClause = (i: NonNullable<Column['identity']>, c?: Column) =>
  `GENERATED ${i === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${c && identityArgs(c) ? ` (START WITH ${c.identityStart ?? 1} INCREMENT BY ${c.identityStep ?? 1})` : ''}`;

/** 컬럼 정의. 생성 컬럼은 DEFAULT 대신 생성식, identity 는 IDENTITY 절 (2026-10-16: 전에는 생성식을 DEFAULT 로 써서 PostgreSQL 이 거부했다) */
function colDef(c: Column): string {
  return [
    q(c.name), c.type, c.notNull ? 'NOT NULL' : '',
    c.generated !== undefined ? `GENERATED ALWAYS AS (${c.generated}) STORED` : c.default !== undefined ? `DEFAULT ${c.default}` : '',
    c.identity ? identityClause(c.identity, c) : '',
  ].filter(Boolean).join(' ');
}

/** 문장 만들기. flyway 면 이름에 모델의 스키마 접두어를 붙이고 IF NOT EXISTS, IF EXISTS 를 쓴다 (2026-10-22: 전에는 늘 public.) */
function ddl(o: DdlOptions = {}): DdlWriter {
  const f = !!o.flyway;
  const schema = o.schema ?? 'public';
  const n = (x: string) => (f ? q(schema) + '.' + q(x) : q(x));
  const ifNot = f ? 'IF NOT EXISTS ' : '';
  const ifEx = f ? 'IF EXISTS ' : '';
  /** flyway 면 제약이 없을 때만 실행 (ADD CONSTRAINT 에는 IF NOT EXISTS 가 없다) */
  const guard = (t: string, sql: string, cond: string) => (f
    ? `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ${lit(n(t))}::regclass AND ${cond}) THEN ${sql} END IF; END $$;`
    : sql);
  const addColumn = (t: string, c: Column) => `ALTER TABLE ${n(t)} ADD COLUMN ${ifNot}${colDef(c)};`;
  const dropColumn = (t: string, c: string) => `ALTER TABLE ${n(t)} DROP COLUMN ${ifEx}${q(c)};`;
  const colComment = (t: string, c: string, cmt: string | undefined) => `COMMENT ON COLUMN ${n(t)}.${q(c)} IS ${cmt ? lit(cmt) : 'NULL'};`;
  return {
    n, q,
    createTable: (t: Table) => [
      `CREATE TABLE ${ifNot}${n(t.name)} (`,
      [...t.columns.map(c => '  ' + colDef(c)), ...(t.pk.length ? [`  PRIMARY KEY (${cols(t.pk)})`] : [])].join(',\n'),
      ');',
    ].join('\n'),
    comments: (t: Table) => [
      ...(t.comment ? [`COMMENT ON TABLE ${n(t.name)} IS ${lit(t.comment)};`] : []),
      ...t.columns.filter(c => c.comment).map(c => colComment(t.name, c.name, c.comment)),
    ],
    tableComment: (t, cmt) => [`COMMENT ON TABLE ${n(t)} IS ${cmt ? lit(cmt) : 'NULL'};`],
    addFk: (t, k) => guard(t,
      `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(k.name)} FOREIGN KEY (${cols(k.columns)}) REFERENCES ${n(k.refTable)} (${cols(k.refColumns)})${fkOptions(k)};`,
      `conname = ${lit(k.name)}`),
    addUq: (t, u) => guard(t, `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(u.name)} UNIQUE (${cols(u.columns)});`, `conname = ${lit(u.name)}`),
    addCk: (t, c) => guard(t, `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`, `conname = ${lit(c.name)}`),
    /** flyway 면 옛 이름이 있을 때만 (여러 번 실행해도 안전) */
    renameTable: (from, to) => `ALTER TABLE ${ifEx}${n(from)} RENAME TO ${q(to)};`,
    renameColumn: (t, from, to) => (f
      ? `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(t)} AND column_name = ${lit(from)}) THEN ALTER TABLE ${n(t)} RENAME COLUMN ${q(from)} TO ${q(to)}; END IF; END $$;`
      : `ALTER TABLE ${n(t)} RENAME COLUMN ${q(from)} TO ${q(to)};`),
    addPk: (t, pk) => guard(t, `ALTER TABLE ${n(t)} ADD PRIMARY KEY (${cols(pk)});`, `contype = 'p'`),
    /** PK 제약 이름은 모델에 없어(단일 PK 는 컬럼 줄 표시뿐) DB 에서 찾아 지운다 */
    dropPk: t => [
      `DO $$`,
      `DECLARE n text;`,
      `BEGIN`,
      `  SELECT conname INTO n FROM pg_constraint WHERE conrelid = ${lit(n(t))}::regclass AND contype = 'p';`,
      `  IF n IS NOT NULL THEN EXECUTE format('ALTER TABLE ${f ? (q(schema) + '.').replace(/'/g, "''") : ''}%I DROP CONSTRAINT %I', ${lit(t)}, n); END IF;`,
      `END $$;`,
    ].join('\n'),
    addIx: (t, i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${ifNot}${q(i.name)} ON ${n(t)} (${cols(i.columns)});`,
    dropIx: (_t, i) => `DROP INDEX ${ifEx}${n(i)};`,
    dropCon: (t, c) => `ALTER TABLE ${n(t)} DROP CONSTRAINT ${ifEx}${q(c)};`,
    dropTable: t => `DROP TABLE ${ifEx}${n(t)};`,
    addColumn: (t, c) => [addColumn(t, c), ...(c.comment ? [colComment(t, c.name, c.comment)] : [])],
    dropColumn,
    alterColumn(tn, a, b) {
      const t = n(tn), c = q(b.name), out: string[] = [];
      // 생성식을 새로 두거나 바꾸는 것은 ALTER 로 안 되어 컬럼을 지우고 다시 만든다 (다른 속성도 새 정의로 함께 들어간다)
      if (a.generated !== b.generated && b.generated !== undefined) {
        out.push(dropColumn(tn, b.name), addColumn(tn, b));
        if (b.comment) out.push(`COMMENT ON COLUMN ${t}.${c} IS ${lit(b.comment)};`);
        return out;
      }
      if (a.generated !== undefined && b.generated === undefined) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} DROP EXPRESSION;`);
      // identity 를 없애는 것은 기본값을 두기 전에, 새로 두는 것은 NOT NULL 뒤에 (기본값이 있으면 identity 를 둘 수 없다)
      if (a.identity && !b.identity) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} DROP IDENTITY IF EXISTS;`);
      if (a.type !== b.type) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${b.type} USING ${c}::${b.type};`);
      if ((a.default ?? null) !== (b.default ?? null)) out.push(b.default !== undefined ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${b.default};` : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`);
      if (a.notNull !== b.notNull) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${b.notNull ? 'SET' : 'DROP'} NOT NULL;`);
      if (!a.identity && b.identity) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ADD ${identityClause(b.identity, b)};`);
      if (a.identity && b.identity && identityArgs(a) !== identityArgs(b)) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} SET START WITH ${b.identityStart ?? 1} SET INCREMENT BY ${b.identityStep ?? 1};`);
      if (a.identity && b.identity && a.identity !== b.identity) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} SET GENERATED ${b.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'};`);
      if ((a.comment ?? '') !== (b.comment ?? '')) out.push(`COMMENT ON COLUMN ${t}.${c} IS ${b.comment ? lit(b.comment) : 'NULL'};`);
      return out;
    },
    createSeq: s => `CREATE SEQUENCE ${ifNot}${n(s.name)} START WITH ${s.start} INCREMENT BY ${s.inc};`,
    alterSeq: s => `ALTER SEQUENCE ${n(s.name)} INCREMENT BY ${s.inc}; -- 시작값은 바꾸지 않는다 (지금 값 ${s.start})`,
    dropSeq: s => `DROP SEQUENCE ${ifEx}${n(s)};`,
    fnSql: fn => fn.definition.replace(/;?\s*$/, '') + ';',
    dropFn: fn => `DROP ${isProcedure(fn) ? 'PROCEDURE' : 'FUNCTION'} ${ifEx}${n(fn.name)}(${fn.args});`,
  };
}

// PostgreSQL 에서 자주 쓰는 키워드 (대문자로 넣는다, DBeaver 기본과 같게)
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'IS NULL', 'IS NOT NULL',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'ON', 'USING',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'DISTINCT ON', 'AS', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
  'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'WITH', 'WITH RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'RETURNING', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE SET',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE', 'CREATE INDEX', 'ADD COLUMN', 'DROP COLUMN', 'PRIMARY KEY', 'REFERENCES',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'EXPLAIN ANALYZE', 'TRUE', 'FALSE', 'NULL', 'DEFAULT', 'INTERVAL',
];

// PostgreSQL 기본 함수 (DB 에 만든 함수는 카탈로그에서 따로 온다)
const FUNCTIONS = [
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least', 'now', 'current_date', 'current_timestamp',
  'to_char', 'to_date', 'to_timestamp', 'to_number', 'date_trunc', 'extract', 'age', 'string_agg', 'array_agg', 'jsonb_agg',
  'json_build_object', 'jsonb_build_object', 'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'substring', 'substr', 'length',
  'lower', 'upper', 'trim', 'lpad', 'rpad', 'replace', 'split_part', 'concat', 'concat_ws', 'position', 'round', 'trunc', 'abs',
  'ceil', 'floor', 'cast', 'nextval', 'currval', 'generate_series', 'unnest', 'exists',
];

export const postgresql: DialectRules = {
  name: 'postgresql',
  label: 'PostgreSQL',
  defaultPort: 5432,
  text: PG_TEXT,
  shortType,
  typeInput: {
    int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint', bool: 'boolean',
    float8: 'double precision', float4: 'real', serial: 'integer', bigserial: 'bigint',
  },
  keywords: KEYWORDS,
  functions: FUNCTIONS,
  limitSelect: (s, n) => `${s}\nLIMIT ${n};`,
  ddl,
  readOnlyByServer: true,
};
