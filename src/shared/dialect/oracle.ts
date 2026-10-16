// Oracle 규칙 (STEP 9). 리버스가 만드는 모양: 이름은 사전 그대로(따옴표 없이 만든 이름은 대문자),
// 타입은 소문자(varchar2(20), varchar2(100 char), number(12,2), number, integer, timestamp(3)), 기본값과 가상 컬럼 식은 DATA_DEFAULT 글자 그대로.
// 대문자가 아닌 이름은 큰따옴표로 감싸 대소문자를 지킨다. DDL 은 바로 커밋된다.
// PL/SQL 블록(BEGIN, CREATE PROCEDURE 등)은 / 줄까지 한 문장이다.

import type { Column, Table } from '../model/types';
import type { DdlWriter, DialectRules } from './index';

const RESERVED = new Set(['ACCESS', 'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'AUDIT', 'BETWEEN', 'BY', 'CHAR', 'CHECK', 'CLUSTER',
  'COLUMN', 'COMMENT', 'COMPRESS', 'CONNECT', 'CREATE', 'CURRENT', 'DATE', 'DECIMAL', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP',
  'ELSE', 'EXCLUSIVE', 'EXISTS', 'FILE', 'FLOAT', 'FOR', 'FROM', 'GRANT', 'GROUP', 'HAVING', 'IDENTIFIED', 'IMMEDIATE', 'IN', 'INCREMENT',
  'INDEX', 'INITIAL', 'INSERT', 'INTEGER', 'INTERSECT', 'INTO', 'IS', 'LEVEL', 'LIKE', 'LOCK', 'LONG', 'MAXEXTENTS', 'MINUS', 'MODE',
  'MODIFY', 'NOAUDIT', 'NOCOMPRESS', 'NOT', 'NOWAIT', 'NULL', 'NUMBER', 'OF', 'OFFLINE', 'ON', 'ONLINE', 'OPTION', 'OR', 'ORDER',
  'PCTFREE', 'PRIOR', 'PUBLIC', 'RAW', 'RENAME', 'RESOURCE', 'REVOKE', 'ROW', 'ROWID', 'ROWNUM', 'ROWS', 'SELECT', 'SESSION', 'SET',
  'SHARE', 'SIZE', 'SMALLINT', 'START', 'SUCCESSFUL', 'SYNONYM', 'SYSDATE', 'TABLE', 'THEN', 'TO', 'TRIGGER', 'UID', 'UNION', 'UNIQUE',
  'UPDATE', 'USER', 'VALIDATE', 'VALUES', 'VARCHAR', 'VARCHAR2', 'VIEW', 'WHENEVER', 'WHERE', 'WITH']);
const q = (n: string) => (/^[A-Z][A-Z0-9_$#]*$/.test(n) && !RESERVED.has(n) ? n : `"${n.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ixCol = (c: string) => (/^[A-Za-z][\w$#]*$/.test(c) ? q(c) : c); // 식 인덱스는 그대로
const NOT_SUPPORTED = (what: string) => `-- [지원 안 함] ${what}`;

function colDef(c: Column): string {
  return [
    q(c.name), c.type,
    c.generated !== undefined ? `GENERATED ALWAYS AS (${c.generated}) VIRTUAL` : '',
    c.identity ? `GENERATED ${c.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY` : '',
    c.generated === undefined && !c.identity && c.default !== undefined ? `DEFAULT ${c.default}` : '',
    c.notNull ? 'NOT NULL' : '',
  ].filter(Boolean).join(' ');
}

function ddl(): DdlWriter {
  const n = q;
  const colComment = (t: string, c: string, cmt: string | undefined) => `COMMENT ON COLUMN ${n(t)}.${q(c)} IS ${lit(cmt ?? '')};`;
  const addColumn = (t: string, c: Column) => [`ALTER TABLE ${n(t)} ADD (${colDef(c)});`, ...(c.comment ? [colComment(t, c.name, c.comment)] : [])];
  const dropColumn = (t: string, c: string) => `ALTER TABLE ${n(t)} DROP COLUMN ${q(c)};`;
  const fkOpts = (k: { onDelete?: string; deferrable?: string }) =>
    `${k.onDelete === 'cascade' || k.onDelete === 'set null' ? ` ON DELETE ${k.onDelete.toUpperCase()}` : ''}${k.deferrable ? ` DEFERRABLE INITIALLY ${k.deferrable === 'deferred' ? 'DEFERRED' : 'IMMEDIATE'}` : ''}`;
  return {
    n, q,
    createTable: (t: Table) => [
      `CREATE TABLE ${n(t.name)} (`,
      [...t.columns.map(c => '  ' + colDef(c)), ...(t.pk.length ? [`  PRIMARY KEY (${t.pk.map(q).join(', ')})`] : [])].join(',\n'),
      ');',
    ].join('\n'),
    comments: t => [
      ...(t.comment ? [`COMMENT ON TABLE ${n(t.name)} IS ${lit(t.comment)};`] : []),
      ...t.columns.filter(c => c.comment).map(c => colComment(t.name, c.name, c.comment)),
    ],
    tableComment: (t, cmt) => [`COMMENT ON TABLE ${n(t)} IS ${lit(cmt ?? '')};`],
    addFk: (t, k) => [
      ...(k.onDelete === 'restrict' || k.onDelete === 'set default' ? [NOT_SUPPORTED(`${k.name}: ON DELETE ${k.onDelete.toUpperCase()} 는 Oracle 에 없다`)] : []),
      ...(k.onUpdate ? [NOT_SUPPORTED(`${k.name}: ON UPDATE 는 Oracle 에 없다`)] : []),
      `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(k.name)} FOREIGN KEY (${k.columns.map(q).join(', ')}) REFERENCES ${n(k.refTable)} (${k.refColumns.map(q).join(', ')})${fkOpts(k)};`,
    ].join('\n'),
    addUq: (t, u) => `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(u.name)} UNIQUE (${u.columns.map(q).join(', ')});`,
    addCk: (t, c) => `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`,
    renameTable: (from, to) => `ALTER TABLE ${n(from)} RENAME TO ${q(to)};`,
    renameColumn: (t, from, to) => `ALTER TABLE ${n(t)} RENAME COLUMN ${q(from)} TO ${q(to)};`,
    addPk: (t, pk) => `ALTER TABLE ${n(t)} ADD PRIMARY KEY (${pk.map(q).join(', ')});`,
    dropPk: t => `ALTER TABLE ${n(t)} DROP PRIMARY KEY;`,
    addIx: (t, i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${n(t)} (${i.columns.map(ixCol).join(', ')});`,
    dropIx: (_t, i) => `DROP INDEX ${q(i)};`,
    dropCon: (t, c) => `ALTER TABLE ${n(t)} DROP CONSTRAINT ${q(c)};`,
    dropTable: t => `DROP TABLE ${n(t)} PURGE;`,
    addColumn,
    dropColumn,
    alterColumn(t, a, b) {
      // 가상 컬럼 식을 두거나 바꾸거나 없애는 것은 지우고 다시 만든다
      if (a.generated !== b.generated) {
        return [...(b.generated === undefined ? [NOT_SUPPORTED(`${t}.${b.name}: 가상 컬럼을 일반 컬럼으로 바꾸면 값이 비어 있다`)] : []), dropColumn(t, b.name), ...addColumn(t, b)];
      }
      const out: string[] = [];
      if (!!a.identity !== !!b.identity) out.push(NOT_SUPPORTED(`${t}.${b.name}: IDENTITY 를 두거나 없애려면 컬럼을 다시 만들어야 한다`));
      else if (a.identity && b.identity && a.identity !== b.identity) out.push(`ALTER TABLE ${n(t)} MODIFY (${q(b.name)} GENERATED ${b.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY);`);
      // MODIFY 에는 바뀐 것만 넣는다 (이미 NOT NULL 인 컬럼에 NOT NULL 을 다시 주면 ORA-01442)
      const parts = [
        a.type !== b.type ? b.type : '',
        (a.default ?? null) !== (b.default ?? null) ? `DEFAULT ${b.default ?? 'NULL'}` : '',
        a.notNull !== b.notNull ? (b.notNull ? 'NOT NULL' : 'NULL') : '',
      ].filter(Boolean);
      if (parts.length) out.push(`ALTER TABLE ${n(t)} MODIFY (${q(b.name)} ${parts.join(' ')});`);
      if ((a.comment ?? '') !== (b.comment ?? '')) out.push(colComment(t, b.name, b.comment));
      return out;
    },
    createSeq: s => `CREATE SEQUENCE ${n(s.name)} START WITH ${s.start} INCREMENT BY ${s.inc};`,
    alterSeq: s => `ALTER SEQUENCE ${n(s.name)} INCREMENT BY ${s.inc}; -- 시작값은 바꾸지 않는다 (지금 값 ${s.start})`,
    dropSeq: s => `DROP SEQUENCE ${n(s)};`,
    fnSql: fn => NOT_SUPPORTED(`함수 ${fn.name}: 다른 DB 의 함수는 모델에 담지 않는다`),
    dropFn: fn => NOT_SUPPORTED(`함수 ${fn.name}: 다른 DB 의 함수는 모델에 담지 않는다`),
  };
}

export const oracle: DialectRules = {
  name: 'oracle',
  label: 'Oracle',
  defaultPort: 1521,
  text: { lineSep: /^\s*\/\s*$/, plsql: true },
  // Oracle 은 VARCHAR 를 VARCHAR2 로 저장한다
  shortType: t => t.replace(/^varchar(?!2)\b/, 'varchar2').replace(/^nvarchar(?!2)\b/, 'nvarchar2'),
  typeInput: { int: 'integer', int4: 'integer', smallint: 'integer', bool: 'boolean', timestamp: 'timestamp(6)', 'number(*,0)': 'integer' },
  keywords: [
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
    'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'ON', 'USING',
    'GROUP BY', 'ORDER BY', 'HAVING', 'FETCH FIRST', 'ROWS ONLY', 'OFFSET', 'DISTINCT', 'AS', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
    'UNION', 'UNION ALL', 'MINUS', 'INTERSECT', 'WITH', 'CONNECT BY', 'START WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'MERGE INTO', 'FROM DUAL',
    'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'CREATE INDEX', 'ADD', 'MODIFY', 'DROP COLUMN', 'PRIMARY KEY', 'REFERENCES',
    'COMMIT', 'ROLLBACK', 'BEGIN', 'DECLARE', 'NULL', 'DEFAULT', 'ROWNUM', 'SYSDATE', 'SYSTIMESTAMP',
  ],
  functions: [
    'count', 'sum', 'avg', 'min', 'max', 'nvl', 'nvl2', 'coalesce', 'nullif', 'decode', 'to_char', 'to_date', 'to_number', 'to_timestamp',
    'trunc', 'round', 'add_months', 'months_between', 'last_day', 'extract', 'substr', 'instr', 'length', 'lower', 'upper', 'trim',
    'lpad', 'rpad', 'replace', 'concat', 'listagg', 'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'abs', 'ceil', 'floor', 'mod',
    'cast', 'regexp_like', 'regexp_substr', 'regexp_replace', 'sys_guid',
  ],
  limitSelect: (s, n) => `${s}\nFETCH FIRST ${n} ROWS ONLY;`,
  ddl,
  readOnlyByServer: false,
};
