// SQL Server 규칙 (STEP 9). 리버스가 만드는 모양: 타입은 소문자(varchar(20), nvarchar(max), decimal(12,2), datetime2(3)),
// 기본값과 계산식은 sys.default_constraints, sys.computed_columns 의 글자 그대로(('A'), ((0)), [qty]*(2)).
// 코멘트는 확장 속성 MS_Description. 기본값 제약 이름은 모델에 없어 DB 에서 찾아 지운다.

import { identityArgs } from '../model/erd-format';
import type { Column, Table } from '../model/types';
import type { DdlOptions, DdlWriter, DialectRules } from './index';

const RESERVED = new Set(['user', 'order', 'group', 'table', 'select', 'from', 'where', 'desc', 'asc', 'key', 'check', 'default', 'primary',
  'references', 'column', 'end', 'index', 'file', 'plan', 'percent', 'top', 'open', 'close', 'function', 'procedure', 'view', 'trigger',
  'rule', 'identity', 'public', 'schema', 'database', 'begin', 'transaction', 'grant', 'values', 'value', 'current']);
const q = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !RESERVED.has(n.toLowerCase()) ? n : `[${n.replace(/]/g, ']]')}]`);
const lit = (s: string) => `N'${s.replace(/'/g, "''")}'`;
const cols = (xs: string[]) => xs.map(q).join(', ');
const NOT_SUPPORTED = (what: string) => `-- [지원 안 함] ${what}`;

function colDef(c: Column): string {
  // 계산 컬럼은 타입 없이 식만 쓴다. 저장 계산 컬럼(PERSISTED)으로 만든다
  if (c.generated !== undefined) return `${q(c.name)} AS (${c.generated}) PERSISTED${c.notNull ? ' NOT NULL' : ''}`;
  return [q(c.name), c.type, c.identity ? `IDENTITY(${c.identityStart ?? 1},${c.identityStep ?? 1})` : '', c.notNull ? 'NOT NULL' : 'NULL', c.default !== undefined ? `DEFAULT ${c.default}` : '']
    .filter(Boolean).join(' ');
}

function ddl(o: DdlOptions = {}): DdlWriter {
  const schema = o.schema ?? 'dbo';
  const n = q;
  // 스크립트를 한 배치로 돌려도 변수 이름이 겹치지 않게 번호를 붙인다
  let k = 0;
  const full = (t: string) => `${q(schema)}.${q(t)}`;
  /** 확장 속성 MS_Description: 있으면 지우고, 새 값이 있으면 다시 둔다 (테이블 또는 컬럼) */
  const comment = (t: string, col: string | undefined, cmt: string | undefined) => {
    const target = `'SCHEMA', ${lit(schema)}, 'TABLE', ${lit(t)}${col ? `, 'COLUMN', ${lit(col)}` : ''}`;
    const where = `major_id = OBJECT_ID(${lit(full(t))}) AND minor_id = ${col ? `COLUMNPROPERTY(OBJECT_ID(${lit(full(t))}), ${lit(col)}, 'ColumnId')` : '0'} AND name = N'MS_Description'`;
    return [
      `IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE class = 1 AND ${where}) EXEC sp_dropextendedproperty N'MS_Description', ${target};`,
      ...(cmt ? [`EXEC sp_addextendedproperty N'MS_Description', ${lit(cmt)}, ${target};`] : []),
    ];
  };
  const addComment = (t: string, col: string | undefined, cmt: string) => `EXEC sp_addextendedproperty N'MS_Description', ${lit(cmt)}, 'SCHEMA', ${lit(schema)}, 'TABLE', ${lit(t)}${col ? `, 'COLUMN', ${lit(col)}` : ''};`;
  /** 컬럼의 기본값 제약을 이름을 찾아 지운다 (한 문장: 변수는 문장 사이에 남지 않는다) */
  const dropDefault = (t: string, c: string, v = `@df${++k}`) =>
    `DECLARE ${v} sysname = (SELECT dc.name FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID(${lit(full(t))}) AND c.name = ${lit(c)}) ${dropBy(t, v)}`;
  /** 이름을 담은 변수로 제약을 지운다. EXEC() 안에서는 함수를 못 불러 문장을 변수에 먼저 만든다 */
  const dropBy = (t: string, v: string) =>
    `IF ${v} IS NOT NULL BEGIN DECLARE ${v}_sql nvarchar(max) = N'ALTER TABLE ${full(t).replace(/'/g, "''")} DROP CONSTRAINT ' + QUOTENAME(${v}) EXEC(${v}_sql) END;`;
  const addColumn = (t: string, c: Column) => [`ALTER TABLE ${n(t)} ADD ${colDef(c)};`, ...(c.comment ? [addComment(t, c.name, c.comment)] : [])];
  const dropColumn = (t: string, c: string) => `${dropDefault(t, c)}\nALTER TABLE ${n(t)} DROP COLUMN ${q(c)};`;
  const fkOpts = (k: { onDelete?: string; onUpdate?: string; deferrable?: string }) => {
    const act = (a?: string) => (a === 'restrict' ? undefined : a?.toUpperCase());
    return [act(k.onDelete) ? ` ON DELETE ${act(k.onDelete)}` : '', act(k.onUpdate) ? ` ON UPDATE ${act(k.onUpdate)}` : ''].join('');
  };
  return {
    n, q,
    createTable: (t: Table) => [
      `CREATE TABLE ${n(t.name)} (`,
      [...t.columns.map(c => '  ' + colDef(c)), ...(t.pk.length ? [`  PRIMARY KEY (${cols(t.pk)})`] : [])].join(',\n'),
      ');',
    ].join('\n'),
    comments: t => [
      ...(t.comment ? [addComment(t.name, undefined, t.comment)] : []),
      ...t.columns.filter(c => c.comment).map(c => addComment(t.name, c.name, c.comment!)),
    ],
    tableComment: (t, cmt) => comment(t, undefined, cmt),
    addFk: (t, k) => [
      ...(k.deferrable ? [NOT_SUPPORTED(`${k.name}: DEFERRABLE 은 SQL Server 에 없다`)] : []),
      ...(k.onDelete === 'restrict' || k.onUpdate === 'restrict' ? [NOT_SUPPORTED(`${k.name}: RESTRICT 는 NO ACTION 으로 만든다`)] : []),
      `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(k.name)} FOREIGN KEY (${cols(k.columns)}) REFERENCES ${n(k.refTable)} (${cols(k.refColumns)})${fkOpts(k)};`,
    ].join('\n'),
    addUq: (t, u) => `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(u.name)} UNIQUE (${cols(u.columns)});`,
    addCk: (t, c) => `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`,
    renameTable: (from, to) => `EXEC sp_rename ${lit(full(from))}, ${lit(to)};`,
    renameColumn: (t, from, to) => `EXEC sp_rename ${lit(`${full(t)}.${q(from)}`)}, ${lit(to)}, 'COLUMN';`,
    addPk: (t, pk) => `ALTER TABLE ${n(t)} ADD PRIMARY KEY (${cols(pk)});`,
    /** PK 제약 이름은 모델에 없어 DB 에서 찾아 지운다 */
    dropPk: (t, v = `@pk${++k}`) => `DECLARE ${v} sysname = (SELECT name FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID(${lit(full(t))}) AND type = 'PK') ${dropBy(t, v)}`,
    addIx: (t, i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${n(t)} (${i.columns.map(c => (/^[A-Za-z_]\w*$/.test(c) ? q(c) : c)).join(', ')});`,
    dropIx: (t, i) => `DROP INDEX ${q(i)} ON ${n(t)};`,
    dropCon: (t, c) => `ALTER TABLE ${n(t)} DROP CONSTRAINT ${q(c)};`,
    dropTable: t => `DROP TABLE ${n(t)};`,
    addColumn,
    dropColumn,
    alterColumn(t, a, b, tables = {}) {
      const c = q(b.name), out: string[] = [];
      // 계산식을 두거나 바꾸거나 없애는 것은 ALTER 로 안 되어 컬럼을 지우고 다시 만든다
      if (a.generated !== b.generated) {
        if (b.generated === undefined) out.push(NOT_SUPPORTED(`${t}.${b.name}: 계산 컬럼을 일반 컬럼으로 바꾸면 값이 사라진다`));
        return [...out, dropColumn(t, b.name), ...addColumn(t, b)];
      }
      if (!!a.identity !== !!b.identity) out.push(NOT_SUPPORTED(`${t}.${b.name}: IDENTITY 를 두거나 없애려면 테이블을 다시 만들어야 한다`));
      else if (a.identity && identityArgs(a) !== identityArgs(b)) out.push(NOT_SUPPORTED(`${t}.${b.name}: IDENTITY 시작값, 증가값은 테이블을 다시 만들어야 바뀐다`));
      const typeChange = a.type !== b.type || a.notNull !== b.notNull;
      const defChange = (a.default ?? null) !== (b.default ?? null);
      // 기본값 제약이 걸린 컬럼은 타입을 바꿀 수 없어 기본값을 먼저 지우고 다시 둔다
      if (defChange || (typeChange && a.default !== undefined)) out.push(dropDefault(t, b.name));
      // 인덱스, UNIQUE 에 든 컬럼은 타입을 바꿀 수 없어 지웠다가 다시 만든다. 정의가 바뀐 것은 차이 목록이 따로 지우고 만든다
      const same = <T>(xs: T[] | undefined, x: T) => xs?.some(y => JSON.stringify(y) === JSON.stringify(x));
      const keepIx = typeChange ? (tables.from?.indexes ?? []).filter(x => x.columns.includes(a.name) && same(tables.to?.indexes, x)) : [];
      const keepUq = typeChange ? (tables.from?.uniques ?? []).filter(x => x.columns.includes(a.name) && same(tables.to?.uniques, x)) : [];
      if (typeChange && tables.from?.pk.includes(a.name)) out.push(NOT_SUPPORTED(`${t}.${b.name}: PK 컬럼의 타입은 PK 와 참조 FK 를 지운 뒤에 바꿀 수 있다`));
      out.push(...keepIx.map(x => `DROP INDEX ${q(x.name)} ON ${n(t)};`), ...keepUq.map(x => `ALTER TABLE ${n(t)} DROP CONSTRAINT ${q(x.name)};`));
      if (typeChange) out.push(`ALTER TABLE ${n(t)} ALTER COLUMN ${c} ${b.type} ${b.notNull ? 'NOT NULL' : 'NULL'};`);
      out.push(...keepUq.map(x => `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(x.name)} UNIQUE (${cols(x.columns)});`),
        ...keepIx.map(x => `CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${q(x.name)} ON ${n(t)} (${cols(x.columns)});`));
      if ((defChange || (typeChange && a.default !== undefined)) && b.default !== undefined) out.push(`ALTER TABLE ${n(t)} ADD DEFAULT ${b.default} FOR ${c};`);
      if ((a.comment ?? '') !== (b.comment ?? '')) out.push(...comment(t, b.name, b.comment));
      return out;
    },
    createSeq: s => `CREATE SEQUENCE ${n(s.name)} START WITH ${s.start} INCREMENT BY ${s.inc};`,
    alterSeq: s => `ALTER SEQUENCE ${n(s.name)} INCREMENT BY ${s.inc}; -- 시작값은 바꾸지 않는다 (지금 값 ${s.start})`,
    dropSeq: s => `DROP SEQUENCE ${n(s)};`,
    fnSql: fn => NOT_SUPPORTED(`함수 ${fn.name}: 다른 DB 의 함수는 모델에 담지 않는다`),
    dropFn: fn => NOT_SUPPORTED(`함수 ${fn.name}: 다른 DB 의 함수는 모델에 담지 않는다`),
  };
}

export const sqlserver: DialectRules = {
  name: 'sqlserver',
  label: 'SQL Server',
  defaultPort: 1433,
  text: { bracket: true, lineSep: /^\s*go\s*$/i },
  shortType: t => t,
  typeInput: {
    integer: 'int', int4: 'int', int8: 'bigint', int2: 'smallint', bool: 'bit', boolean: 'bit',
    datetime2: 'datetime2(7)', time: 'time(7)', datetimeoffset: 'datetimeoffset(7)', decimal: 'decimal(18,0)', numeric: 'numeric(18,0)',
  },
  keywords: [
    'SELECT', 'TOP', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
    'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'CROSS APPLY', 'OUTER APPLY', 'ON',
    'GROUP BY', 'ORDER BY', 'HAVING', 'OFFSET', 'FETCH NEXT', 'ROWS ONLY', 'DISTINCT', 'AS', 'ASC', 'DESC', 'WITH (NOLOCK)',
    'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'OUTPUT', 'MERGE',
    'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'CREATE INDEX', 'ADD', 'DROP COLUMN', 'PRIMARY KEY', 'REFERENCES',
    'BEGIN TRAN', 'COMMIT', 'ROLLBACK', 'DECLARE', 'EXEC', 'NULL', 'DEFAULT', 'GO',
  ],
  functions: [
    'count', 'sum', 'avg', 'min', 'max', 'isnull', 'coalesce', 'nullif', 'getdate', 'sysdatetime', 'getutcdate', 'dateadd', 'datediff',
    'datepart', 'eomonth', 'format', 'convert', 'cast', 'try_convert', 'len', 'datalength', 'charindex', 'substring', 'left', 'right',
    'ltrim', 'rtrim', 'trim', 'upper', 'lower', 'replace', 'concat', 'concat_ws', 'string_agg', 'row_number', 'rank', 'dense_rank',
    'lag', 'lead', 'round', 'abs', 'ceiling', 'floor', 'iif', 'newid', 'object_id',
  ],
  limitSelect: (s, n) => `${s.replace(/^SELECT /, `SELECT TOP ${n} `)};`,
  ddl,
  readOnlyByServer: false,
};
