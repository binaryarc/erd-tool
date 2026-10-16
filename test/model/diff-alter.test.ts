import { describe, expect, it } from 'vitest';
import { diffModels, narrowing } from '../../src/shared/model/diff';
import { buildAlter } from '../../src/shared/sql/alter';
import { updateColumn, updateTable } from '../../src/shared/model/edit';
import { splitStatements } from '../../src/shared/sql/text';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id: 't1', name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const model = (tables: Table[], extra: Partial<SchemaModel> = {}): SchemaModel =>
  ({ version: 1, groups: [], common: [], sequences: [], functions: [], tables, ...extra });

const base = model([
  table('mst_biz', [col('biz_seq', 'integer', { notNull: true }), col('biz_nm', 'varchar(100)'), col('memo', 'text')], { pk: ['biz_seq'] }),
  table('mst_wh', [col('wh_seq', 'integer', { notNull: true }), col('biz_seq', 'integer')], {
    pk: ['wh_seq'], fks: [{ name: 'fk_wh_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] }],
    indexes: [{ name: 'ix_wh_biz', columns: ['biz_seq'], unique: false }],
  }),
  table('old_log', [col('id', 'integer')]),
], { functions: [{ name: 'fn_a', args: 'text', definition: 'CREATE OR REPLACE FUNCTION public.fn_a(text)\n RETURNS text\n LANGUAGE sql\nAS $function$ select $1 $function$' }] });

const changed = model([
  table('mst_biz', [col('biz_seq', 'integer', { notNull: true }), col('biz_nm', 'varchar(50)', { notNull: true }), col('sort_no', 'integer', { default: '0' })], { pk: ['biz_seq'], comment: '사업장' }),
  table('mst_wh', [col('wh_seq', 'integer', { notNull: true }), col('biz_seq', 'integer')], {
    pk: ['wh_seq'], fks: [{ name: 'fk_wh_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] }],
    uniques: [{ name: 'uq_wh', columns: ['wh_seq', 'biz_seq'] }],
  }),
  table('mst_center', [col('center_seq', 'integer', { notNull: true }), col('biz_seq', 'integer')], {
    pk: ['center_seq'], comment: "센터's", fks: [{ name: 'fk_center_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] }],
  }),
], { sequences: [{ name: 'mst_center_seq', start: 1, inc: 1 }] });

describe('차이 계산', () => {
  const d = diffModels(base, changed);
  const find = (kind: string, change: string, name: string) => d.find(x => x.kind === kind && x.change === change && x.name === name);

  it('테이블, 컬럼, 키, 인덱스, 시퀀스, 함수의 추가, 삭제, 변경을 찾는다', () => {
    expect(find('table', 'add', 'mst_center')).toBeTruthy();
    expect(find('table', 'drop', 'old_log')?.danger).toContain('데이터가 사라진다');
    expect(find('column', 'add', 'sort_no')).toBeTruthy();
    expect(find('column', 'drop', 'memo')?.danger).toContain('사라진다');
    expect(find('table', 'alter', 'mst_biz')?.detail).toBe('테이블 코멘트');
    expect(find('unique', 'add', 'uq_wh')).toBeTruthy();
    expect(find('index', 'drop', 'ix_wh_biz')).toBeTruthy();
    expect(find('sequence', 'add', 'mst_center_seq')).toBeTruthy();
    expect(find('function', 'drop', 'fn_a(text)')?.danger).toBeTruthy();
    expect(find('fk', 'alter', 'fk_wh_biz')).toBeUndefined(); // 그대로인 FK 는 차이가 아니다
  });

  it('타입 축소와 NOT NULL 로 바꾸기는 위험으로 표시한다', () => {
    const c = find('column', 'alter', 'biz_nm')!;
    expect(c.detail).toBe('타입 varchar(100) → varchar(50), NULL 허용 → NOT NULL');
    expect(c.danger).toBe('길이를 100 에서 50 로 줄인다');
  });

  it('넓히는 타입 변경은 위험이 아니다', () => {
    expect(narrowing('integer', 'bigint')).toBeUndefined();
    expect(narrowing('varchar(50)', 'varchar(100)')).toBeUndefined();
    expect(narrowing('varchar(50)', 'text')).toBeUndefined();
    expect(narrowing('numeric(10,2)', 'numeric(10,0)')).toBe('소수 자리를 2 에서 0 로 줄인다');
    expect(narrowing('varchar(10)', 'integer')).toContain('변환이 실패할 수 있다');
  });

  it('같은 모델은 차이가 없고, 함수 정의의 공백 차이는 무시한다', () => {
    expect(diffModels(base, base)).toEqual([]);
    const spaced = { ...base, functions: [{ ...base.functions[0], definition: base.functions[0].definition.replace(/\n/g, '\n  ') }] };
    expect(diffModels(base, spaced)).toEqual([]);
  });
});

describe('ALTER 만들기', () => {
  const r = buildAlter(base, changed);
  const stmts = splitStatements(r.sql).map(s => s.text.replace(/^(--[^\n]*\n)+/, ''));
  const idx = (re: RegExp) => stmts.findIndex(s => re.test(s));

  it('지우기 → 시퀀스 → 컬럼 → 새 테이블 → 키 → FK → 함수 순서', () => {
    expect(idx(/^DROP INDEX ix_wh_biz/)).toBeLessThan(idx(/^DROP TABLE old_log/));
    expect(idx(/^CREATE SEQUENCE mst_center_seq/)).toBeLessThan(idx(/^CREATE TABLE mst_center/));
    expect(idx(/ALTER COLUMN biz_nm TYPE varchar\(50\)/)).toBeLessThan(idx(/^CREATE TABLE mst_center/));
    expect(idx(/^CREATE TABLE mst_center/)).toBeLessThan(idx(/ADD CONSTRAINT uq_wh UNIQUE/));
    expect(idx(/ADD CONSTRAINT fk_center_biz FOREIGN KEY/)).toBeGreaterThan(idx(/^CREATE TABLE mst_center/));
    expect(idx(/^DROP FUNCTION fn_a\(text\)/)).toBe(stmts.length - 1);
  });

  it('위험 문장 위에 [위험] 주석을 달고 개수를 센다', () => {
    expect(r.sql).toContain('-- [위험] old_log: 테이블과 데이터가 사라진다\nDROP TABLE old_log;');
    expect(r.sql).toContain('-- [위험] mst_biz.biz_nm: 길이를 100 에서 50 로 줄인다');
    expect(r.dangers).toBe(4); // 테이블 삭제, 컬럼 삭제, 타입 축소, 함수 삭제
  });

  it('코멘트의 작은따옴표를 이스케이프하고, 새 컬럼 기본값과 NOT NULL 을 넣는다', () => {
    expect(r.sql).toContain("COMMENT ON TABLE mst_center IS '센터''s';");
    expect(r.sql).toContain('ALTER TABLE mst_biz ADD COLUMN sort_no integer DEFAULT 0;');
    expect(r.sql).toContain('ALTER TABLE mst_biz ALTER COLUMN biz_nm SET NOT NULL;');
  });

  it('PK 를 바꿀 때는 DB 에서 제약 이름을 찾아 지운다', () => {
    const a = model([table('t', [col('a', 'integer', { notNull: true }), col('b', 'integer', { notNull: true })], { pk: ['a'] })]);
    const b = model([table('t', [col('a', 'integer', { notNull: true }), col('b', 'integer', { notNull: true })], { pk: ['a', 'b'] })]);
    const s = buildAlter(a, b).sql;
    expect(s).toContain("contype = 'p'");
    expect(s).toContain('ALTER TABLE t ADD PRIMARY KEY (a, b);');
  });

  it('예약어 이름은 큰따옴표로 감싼다', () => {
    const a = model([table('mst_user', [col('id', 'integer')])]);
    const b = model([table('mst_user', [col('id', 'integer'), col('order', 'integer')])]);
    expect(buildAlter(a, b).sql).toContain('ADD COLUMN "order" integer;');
  });

  it('화면에서 바꾼 이름은 삭제, 추가가 아니라 RENAME 이다 (거꾸로 비교하면 되돌리는 RENAME)', () => {
    let m = updateTable(base, 'mst_wh', { name: 'mst_warehouse' });
    m = updateColumn(m, 'mst_biz', 'biz_nm', { name: 'biz_name' });
    const items = diffModels(base, m);
    expect(items.map(i => `${i.kind} ${i.change} ${i.detail}`)).toEqual(['table rename mst_wh → mst_warehouse', 'column rename biz_nm → biz_name']);
    const sql = buildAlter(base, m).sql;
    expect(sql).toContain('ALTER TABLE mst_wh RENAME TO mst_warehouse;');
    expect(sql).toContain('ALTER TABLE mst_biz RENAME COLUMN biz_nm TO biz_name;');
    expect(sql).not.toMatch(/DROP|ADD/);
    const back = buildAlter(m, base).sql;
    expect(back).toContain('ALTER TABLE mst_warehouse RENAME TO mst_wh;');
    expect(back).toContain('ALTER TABLE mst_biz RENAME COLUMN biz_name TO biz_nm;');
    // Flyway 는 여러 번 실행해도 안전하게
    const fw = buildAlter(base, m, undefined, { flyway: true }).sql;
    expect(fw).toContain('ALTER TABLE IF EXISTS public.mst_wh RENAME TO mst_warehouse;');
    expect(fw).toContain("column_name = 'biz_nm') THEN ALTER TABLE public.mst_biz RENAME COLUMN biz_nm TO biz_name;");
  });

  it('이름을 바꾸고 타입도 바꾸면 RENAME 뒤에 새 이름으로 ALTER', () => {
    const m = updateColumn(base, 'mst_biz', 'biz_nm', { name: 'biz_name', type: 'varchar(200)' });
    const stmts = splitStatements(buildAlter(base, m).sql).map(s => s.text.replace(/^(--[^\n]*\n|\s)*/, ''));
    expect(stmts).toEqual(['ALTER TABLE mst_biz RENAME COLUMN biz_nm TO biz_name', 'ALTER TABLE mst_biz ALTER COLUMN biz_name TYPE varchar(200) USING biz_name::varchar(200)']);
  });

  it('이름을 원래대로 되돌리면 기록이 지워져 차이가 없다', () => {
    const m = updateColumn(updateColumn(base, 'mst_biz', 'biz_nm', { name: 'x' }), 'mst_biz', 'x', { name: 'biz_nm' });
    expect(diffModels(base, m)).toEqual([]);
  });

  it('CHECK 제약 추가, 삭제와 identity, 생성 컬럼의 DDL', () => {
    const a = model([table('t', [col('id', 'integer', { notNull: true }), col('qty', 'integer')], { pk: ['id'] })]);
    const b = model([table('t', [col('id', 'integer', { notNull: true, identity: 'always' }), col('qty', 'integer'), col('qty2', 'integer', { generated: 'qty * 2' })],
      { pk: ['id'], checks: [{ name: 'ck_qty', definition: 'CHECK ((qty >= 0))' }] })]);
    const sql = buildAlter(a, b).sql;
    expect(sql).toContain('ALTER TABLE t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;');
    expect(sql).toContain('ALTER TABLE t ADD COLUMN qty2 integer GENERATED ALWAYS AS (qty * 2) STORED;');
    expect(sql).toContain('ALTER TABLE t ADD CONSTRAINT ck_qty CHECK ((qty >= 0));');
    expect(sql).not.toContain('DEFAULT (qty * 2)');
    const back = buildAlter(b, a).sql;
    expect(back).toContain('ALTER TABLE t DROP CONSTRAINT ck_qty;');
    expect(back).toContain('ALTER TABLE t ALTER COLUMN id DROP IDENTITY IF EXISTS;');
    // 새 테이블은 CREATE 안에 IDENTITY, 생성식이 들어간다
    const create = buildAlter(model([]), b).sql;
    expect(create).toContain('  id integer NOT NULL GENERATED ALWAYS AS IDENTITY,');
    expect(create).toContain('  qty2 integer GENERATED ALWAYS AS (qty * 2) STORED');
  });

  it('컬럼 이름 바꾸기와 삭제는 CHECK 식도 따라간다', () => {
    const a = model([table('t', [col('qty', 'integer'), col('qty2', 'integer', { generated: 'qty * 2' })], { checks: [{ name: 'ck_qty', definition: 'CHECK ((qty >= 0))' }] })]);
    const r = updateColumn(a, 't', 'qty', { name: 'amount' });
    expect(r.tables[0].checks).toEqual([{ name: 'ck_qty', definition: 'CHECK ((amount >= 0))' }]);
    expect(r.tables[0].columns[1].generated).toBe('amount * 2');
    expect(diffModels(a, r).map(i => i.change)).toEqual(['rename']); // CHECK, 생성식은 PostgreSQL 이 따라 바꾸므로 따로 차이가 없다
  });
});
