// MySQL 규칙 (STEP 9). 리버스가 만드는 모양: 타입은 information_schema.COLUMNS.COLUMN_TYPE 그대로(int, varchar(20), decimal(12,2), int unsigned),
// 기본값은 SQL 에 쓰는 모양('A', 0.00, CURRENT_TIMESTAMP(3), (식)), 생성식은 바깥 괄호를 벗긴 식.
// 코멘트는 컬럼 정의와 테이블 옵션(COMMENT=)에 들어간다. 컬럼을 바꿀 때는 MODIFY COLUMN 으로 정의 전체를 다시 쓴다.
// DDL 은 바로 커밋된다(트랜잭션으로 되돌릴 수 없다).

import type { Column, Table } from '../model/types';
import type { DdlWriter, DialectRules } from './index';

const RESERVED = new Set(['user', 'order', 'group', 'table', 'select', 'from', 'where', 'desc', 'asc', 'key', 'keys', 'check', 'default',
  'primary', 'references', 'column', 'index', 'range', 'rank', 'interval', 'condition', 'release', 'read', 'write', 'usage', 'values',
  'status', 'function', 'procedure', 'trigger', 'database', 'schema', 'limit', 'match', 'option', 'rows', 'row', 'groups', 'lead', 'lag']);
const q = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !RESERVED.has(n.toLowerCase()) ? n : `\`${n.replace(/`/g, '``')}\``);
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
const ixCol = (c: string) => (/^[A-Za-z_]\w*$/.test(c) ? q(c) : `(${c})`); // 식 인덱스는 괄호로 감싼다
const NOT_SUPPORTED = (what: string) => `-- [지원 안 함] ${what}`;

function colDef(c: Column): string {
  return [
    q(c.name), c.type,
    c.generated !== undefined ? `GENERATED ALWAYS AS (${c.generated}) STORED` : '',
    c.notNull ? 'NOT NULL' : 'NULL',
    c.generated === undefined && c.default !== undefined ? `DEFAULT ${c.default}` : '',
    c.identity ? 'AUTO_INCREMENT' : '',
    c.comment ? `COMMENT ${lit(c.comment)}` : '',
  ].filter(Boolean).join(' ');
}

function ddl(): DdlWriter {
  const n = q;
  const addColumn = (t: string, c: Column) => [`ALTER TABLE ${n(t)} ADD COLUMN ${colDef(c)};`];
  const dropColumn = (t: string, c: string) => `ALTER TABLE ${n(t)} DROP COLUMN ${q(c)};`;
  const fkOpts = (k: { onDelete?: string; onUpdate?: string }) =>
    `${k.onDelete ? ` ON DELETE ${k.onDelete.toUpperCase()}` : ''}${k.onUpdate ? ` ON UPDATE ${k.onUpdate.toUpperCase()}` : ''}`;
  return {
    n, q,
    // 코멘트는 정의 안에 넣으므로 comments() 는 비어 있다
    createTable: (t: Table) => [
      `CREATE TABLE ${n(t.name)} (`,
      [...t.columns.map(c => '  ' + colDef(c)), ...(t.pk.length ? [`  PRIMARY KEY (${t.pk.map(q).join(', ')})`] : [])].join(',\n'),
      `)${t.comment ? ` COMMENT = ${lit(t.comment)}` : ''};`,
    ].join('\n'),
    comments: () => [],
    tableComment: (t, cmt) => [`ALTER TABLE ${n(t)} COMMENT = ${lit(cmt ?? '')};`],
    addFk: (t, k) => [
      ...(k.deferrable ? [NOT_SUPPORTED(`${k.name}: DEFERRABLE 은 MySQL 에 없다`)] : []),
      `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(k.name)} FOREIGN KEY (${k.columns.map(q).join(', ')}) REFERENCES ${n(k.refTable)} (${k.refColumns.map(q).join(', ')})${fkOpts(k)};`,
    ].join('\n'),
    addUq: (t, u) => `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(u.name)} UNIQUE (${u.columns.map(q).join(', ')});`,
    addCk: (t, c) => `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`,
    renameTable: (from, to) => `RENAME TABLE ${n(from)} TO ${q(to)};`,
    renameColumn: (t, from, to) => `ALTER TABLE ${n(t)} RENAME COLUMN ${q(from)} TO ${q(to)};`,
    addPk: (t, pk) => `ALTER TABLE ${n(t)} ADD PRIMARY KEY (${pk.map(q).join(', ')});`,
    dropPk: t => `ALTER TABLE ${n(t)} DROP PRIMARY KEY;`,
    addIx: (t, i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${n(t)} (${i.columns.map(ixCol).join(', ')});`,
    dropIx: (t, i) => `DROP INDEX ${q(i)} ON ${n(t)};`,
    dropCon: (t, c) => `ALTER TABLE ${n(t)} DROP CONSTRAINT ${q(c)};`,
    dropTable: t => `DROP TABLE ${n(t)};`,
    addColumn,
    dropColumn,
    alterColumn(t, a, b) {
      // 생성식을 두거나 바꾸거나 없애는 것은 지우고 다시 만든다 (일반 컬럼과 생성 컬럼 사이는 MODIFY 로 바꿀 수 없다)
      if (a.generated !== b.generated) {
        return [...(b.generated === undefined ? [NOT_SUPPORTED(`${t}.${b.name}: 생성 컬럼을 일반 컬럼으로 바꾸면 값이 사라진다`)] : []), dropColumn(t, b.name), ...addColumn(t, b)];
      }
      return [`ALTER TABLE ${n(t)} MODIFY COLUMN ${colDef(b)};`];
    },
    createSeq: s => NOT_SUPPORTED(`시퀀스 ${s.name}: MySQL 에는 시퀀스가 없다 (AUTO_INCREMENT 를 쓴다)`),
    alterSeq: s => NOT_SUPPORTED(`시퀀스 ${s.name}: MySQL 에는 시퀀스가 없다`),
    dropSeq: s => NOT_SUPPORTED(`시퀀스 ${s}: MySQL 에는 시퀀스가 없다`),
    fnSql: fn => NOT_SUPPORTED(`함수 ${fn.name}: 다른 DB 의 함수는 모델에 담지 않는다`),
    dropFn: fn => NOT_SUPPORTED(`함수 ${fn.name}: 다른 DB 의 함수는 모델에 담지 않는다`),
  };
}

export const mysql: DialectRules = {
  name: 'mysql',
  label: 'MySQL',
  defaultPort: 3306,
  text: { backtick: true, hash: true, backslash: true, doubleQuoteString: true },
  shortType: t => t,
  typeInput: { integer: 'int', int4: 'int', int8: 'bigint', int2: 'smallint', bool: 'tinyint(1)', boolean: 'tinyint(1)' },
  keywords: [
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'REGEXP', 'IS NULL', 'IS NOT NULL',
    'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'STRAIGHT_JOIN', 'ON', 'USING',
    'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'AS', 'ASC', 'DESC', 'WITH ROLLUP',
    'UNION', 'UNION ALL', 'WITH', 'WITH RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'INSERT INTO', 'VALUES', 'ON DUPLICATE KEY UPDATE', 'REPLACE INTO', 'UPDATE', 'SET', 'DELETE FROM',
    'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'CREATE INDEX', 'ADD COLUMN', 'MODIFY COLUMN', 'DROP COLUMN',
    'PRIMARY KEY', 'REFERENCES', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'SHOW TABLES', 'DESCRIBE', 'NULL', 'DEFAULT',
  ],
  functions: [
    'count', 'sum', 'avg', 'min', 'max', 'ifnull', 'coalesce', 'nullif', 'if', 'now', 'curdate', 'current_timestamp', 'date_format',
    'str_to_date', 'date_add', 'date_sub', 'datediff', 'timestampdiff', 'last_day', 'concat', 'concat_ws', 'group_concat', 'substring',
    'substring_index', 'left', 'right', 'length', 'char_length', 'lower', 'upper', 'trim', 'lpad', 'rpad', 'replace', 'instr', 'locate',
    'round', 'truncate', 'abs', 'ceil', 'floor', 'cast', 'convert', 'json_extract', 'json_object', 'row_number', 'rank', 'dense_rank',
    'lag', 'lead', 'last_insert_id', 'uuid',
  ],
  limitSelect: (s, n) => `${s}\nLIMIT ${n};`,
  ddl,
  readOnlyByServer: true,
};
