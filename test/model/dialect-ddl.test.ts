// DB 종류별 규칙 (STEP 9): 문장 나누기, 행 수 제한, DDL 모양
import { describe, expect, it } from 'vitest';
import { normalizeTypeFor, rulesFor } from '../../src/shared/dialect';
import type { SchemaModel, Table } from '../../src/shared/model/types';
import { buildAlter } from '../../src/shared/sql/alter';
import { buildJoinSelect } from '../../src/shared/sql/join';
import { splitStatements } from '../../src/shared/sql/text';

const table = (name: string, extra: Partial<Table> = {}): Table =>
  ({ id: name, name, comment: '', columns: [{ name: 'id', type: 'int', notNull: true }], pk: ['id'], fks: [], uniques: [], indexes: [], ...extra });
const model = (dialect: SchemaModel['dialect'], tables: Table[]): SchemaModel =>
  ({ version: 2, dialect, schema: 'dbo', groups: [], common: [], sequences: [], functions: [], tables });

describe('SQL Server', () => {
  const text = rulesFor('sqlserver').text;
  it('GO 줄과 ; 로 나누고, [ ] 식별자 안의 ; 는 무시한다', () => {
    const sql = 'select [a;b] from t;\nselect 2\nGO\ngo\nCREATE VIEW v AS SELECT 1\n  GO  \nselect 3';
    expect(splitStatements(sql, text).map(s => s.text)).toEqual(['select [a;b] from t', 'select 2', 'CREATE VIEW v AS SELECT 1', 'select 3']);
  });
  it('JOIN SELECT 는 TOP 으로 행 수를 제한하고, 타입 입력은 SQL Server 이름으로 맞춘다', () => {
    expect(buildJoinSelect(model('sqlserver', [table('erd_a')]), ['erd_a'])).toBe('SELECT TOP 100 a.*\n  FROM erd_a a;');
    expect(['INTEGER', 'bool', 'datetime2', 'NVARCHAR( 20 )'].map(t => normalizeTypeFor('sqlserver', t))).toEqual(['int', 'bit', 'datetime2(7)', 'nvarchar(20)']);
  });
  it('컬럼 추가는 코멘트를 확장 속성으로, 컬럼 삭제는 기본값 제약을 먼저 지운다', () => {
    const a = model('sqlserver', [table('erd_a')]);
    const b = model('sqlserver', [table('erd_a', { columns: [{ name: 'id', type: 'int', notNull: true }, { name: 'qty', type: 'int', notNull: true, default: '((0))', comment: '수량' }] })]);
    const add = buildAlter(a, b).sql;
    expect(add).toContain('ALTER TABLE erd_a ADD qty int NOT NULL DEFAULT ((0));');
    expect(add).toContain("EXEC sp_addextendedproperty N'MS_Description', N'수량', 'SCHEMA', N'dbo', 'TABLE', N'erd_a', 'COLUMN', N'qty';");
    const drop = buildAlter(b, a).sql;
    expect(drop).toMatch(/DECLARE @df1 sysname = .* IF @df1 IS NOT NULL BEGIN .*EXEC\(@df1_sql\) END;\nALTER TABLE erd_a DROP COLUMN qty;/);
  });
  it('DEFERRABLE, RESTRICT 는 지원 안 함 주석을 달고 문장은 만든다', () => {
    const p = table('erd_p');
    const c = table('erd_c', { fks: [{ name: 'fk_c', columns: ['id'], refTable: 'erd_p', refColumns: ['id'], onDelete: 'restrict', deferrable: 'deferred' }] });
    const sql = buildAlter(model('sqlserver', [p, table('erd_c')]), model('sqlserver', [p, c])).sql;
    expect(sql).toContain('-- [지원 안 함] fk_c: DEFERRABLE 은 SQL Server 에 없다');
    expect(sql).toContain('ALTER TABLE erd_c ADD CONSTRAINT fk_c FOREIGN KEY (id) REFERENCES erd_p (id);');
  });
});

describe('MySQL', () => {
  const text = rulesFor('mysql').text;
  it('백틱 식별자, 큰따옴표 문자열, # 주석, 역슬래시 안의 ; 는 나누지 않는다', () => {
    const sql = "select `a;b` from t; # 주석 ;\nselect \"x;y\", 'it\\'s;' from u";
    expect(splitStatements(sql, text).map(s => s.text)).toEqual(['select `a;b` from t', "# 주석 ;\nselect \"x;y\", 'it\\'s;' from u"]);
  });
  it('컬럼 변경은 MODIFY COLUMN 으로 정의 전체를 다시 쓰고, 코멘트는 정의 안에 둔다', () => {
    const a = model('mysql', [table('erd_a', { columns: [{ name: 'id', type: 'int', notNull: true }, { name: 'nm', type: 'varchar(10)', notNull: false }] })]);
    const b = model('mysql', [table('erd_a', { comment: '가', columns: [{ name: 'id', type: 'int', notNull: true }, { name: 'nm', type: 'varchar(20)', notNull: true, default: "'x'", comment: '이름' }] })]);
    const sql = buildAlter(a, b).sql;
    expect(sql).toContain("ALTER TABLE erd_a MODIFY COLUMN nm varchar(20) NOT NULL DEFAULT 'x' COMMENT '이름';");
    expect(sql).toContain("ALTER TABLE erd_a COMMENT = '가';");
    expect(['INTEGER', 'bool'].map(t => normalizeTypeFor('mysql', t))).toEqual(['int', 'tinyint(1)']);
  });
});
