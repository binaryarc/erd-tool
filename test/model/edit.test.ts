import { describe, expect, it } from 'vitest';
import {
  EditError, EditHistory, NEW_COLUMN_TYPE, addColumn, addFk, addTable, dropColumn, dropFk, dropTable, moveColumn, nextColumnName, normalizeType, pasteColumns, updateColumn, updateTable,
} from '../../src/shared/model/edit';
import { diffModels } from '../../src/shared/model/diff';
import { serializeModel, parseModel } from '../../src/shared/model/erd-format';
import { validateModel } from '../../src/shared/model/validate';
import { buildCreateAll } from '../../src/shared/sql/create';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const common = [col('reg_id', 'varchar(20)', { notNull: true }), col('reg_dt', 'timestamp', { notNull: true, default: 'now()' })];

const base: SchemaModel = {
  version: 1, groups: [{ name: 'mst', prefix: 'mst_', isDefault: true }], common, sequences: [], functions: [],
  tables: [
    table('t1', 'mst_brand', [col('brand_seq', 'integer', { notNull: true }), col('brand_nm', 'varchar(100)'), ...common], { pk: ['brand_seq'] }),
    table('t3', 'mst_wh', [col('wh_seq', 'integer', { notNull: true }), col('brand_seq', 'integer')], {
      pk: ['wh_seq'], fks: [{ name: 'fk_wh_brand', columns: ['brand_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] }],
      indexes: [{ name: 'ix_wh_brand', columns: ['brand_seq'], unique: false }], uniques: [{ name: 'uq_wh', columns: ['wh_seq', 'brand_seq'] }],
    }),
  ],
};
const T = (m: SchemaModel, n: string) => m.tables.find(t => t.name === n)!;
const valid = (m: SchemaModel) => validateModel(parseModel(serializeModel(m)));

describe('ERD 수정 명령', () => {
  it('테이블 추가: 다음 ID, 공통 컬럼 넣기, 이름 중복 막기', () => {
    const m = addTable(base, 'mst_center', { comment: '센터', withCommon: true });
    expect(T(m, 'mst_center')).toMatchObject({ id: 't4', comment: '센터', columns: common });
    expect(() => addTable(m, 'mst_brand')).toThrow(EditError);
    expect(() => addTable(m, ' ')).toThrow(EditError);
    expect(base.tables).toHaveLength(2); // 원래 모델은 그대로
  });

  it('컬럼 추가는 공통 컬럼 앞에 들어가 +common 저장이 유지된다', () => {
    const m = addColumn(base, 'mst_brand', { name: 'sort_no', type: 'INT', notNull: true, default: '0' });
    expect(T(m, 'mst_brand').columns.map(c => c.name)).toEqual(['brand_seq', 'brand_nm', 'sort_no', 'reg_id', 'reg_dt']);
    expect(T(m, 'mst_brand').columns[2]).toEqual({ name: 'sort_no', type: 'integer', notNull: true, default: '0' });
    expect(serializeModel(m)['tables.erd']).toContain('mst_brand @t1 +common');
    expect(addColumn(base, 'mst_wh', { name: 'x', type: 'text', notNull: false }, 'wh_seq').tables[1].columns.map(c => c.name)).toEqual(['wh_seq', 'x', 'brand_seq']);
    expect(() => addColumn(base, 'mst_brand', { name: 'brand_nm', type: 'text', notNull: false })).toThrow('이미 있습니다');
  });

  it('PK 로 고르면 NOT NULL 도 켠다', () => {
    const m = addColumn(base, 'mst_wh', { name: 'center_seq', type: 'integer', notNull: false, pk: true });
    expect(T(m, 'mst_wh').pk).toEqual(['wh_seq', 'center_seq']);
    expect(T(m, 'mst_wh').columns.at(-1)!.notNull).toBe(true);
    const off = updateColumn(m, 'mst_wh', 'center_seq', { pk: false });
    expect(T(off, 'mst_wh').pk).toEqual(['wh_seq']);
  });

  it('컬럼 이름 바꾸기는 PK, 자기 FK, UNIQUE, 인덱스, 다른 테이블의 FK 참조를 함께 고친다', () => {
    const m1 = updateColumn(base, 'mst_wh', 'brand_seq', { name: 'brand_no' });
    expect(T(m1, 'mst_wh').fks[0].columns).toEqual(['brand_no']);
    expect(T(m1, 'mst_wh').indexes[0].columns).toEqual(['brand_no']);
    expect(T(m1, 'mst_wh').uniques[0].columns).toEqual(['wh_seq', 'brand_no']);
    const m2 = updateColumn(base, 'mst_brand', 'brand_seq', { name: 'brand_id', comment: '사업장 ID' });
    expect(T(m2, 'mst_brand').pk).toEqual(['brand_id']);
    expect(T(m2, 'mst_wh').fks[0].refColumns).toEqual(['brand_id']);
    expect(T(m2, 'mst_brand').columns[0]).toEqual({ name: 'brand_id', type: 'integer', notNull: true, comment: '사업장 ID', renamedFrom: 'brand_seq' });
    expect(valid(m2)).toEqual([]);
  });

  it('컬럼 고치기: 빈 기본값과 빈 코멘트는 없는 것으로', () => {
    const m = updateColumn(base, 'mst_brand', 'reg_dt', { default: '', comment: '' });
    expect(T(m, 'mst_brand').columns.at(-1)).toEqual({ name: 'reg_dt', type: 'timestamp', notNull: true });
  });

  it('테이블 이름 바꾸기는 ID 를 지키고 다른 테이블의 FK 참조를 고친다', () => {
    const m = updateTable(base, 'mst_brand', { name: 'mst_company', comment: '회사' });
    expect(T(m, 'mst_company')).toMatchObject({ id: 't1', comment: '회사' });
    expect(T(m, 'mst_wh').fks[0].refTable).toBe('mst_company');
    expect(() => updateTable(base, 'mst_brand', { name: 'mst_wh' })).toThrow('이미 있습니다');
  });

  it('지우기는 그 대상을 가리키는 키를 함께 지운다', () => {
    const noBiz = dropTable(base, 'mst_brand');
    expect(T(noBiz, 'mst_wh').fks).toEqual([]);
    const noCol = dropColumn(base, 'mst_wh', 'brand_seq');
    expect(T(noCol, 'mst_wh')).toMatchObject({ fks: [], indexes: [], uniques: [], pk: ['wh_seq'] });
    const noRef = dropColumn(base, 'mst_brand', 'brand_seq');
    expect(T(noRef, 'mst_brand').pk).toEqual([]);
    expect(T(noRef, 'mst_wh').fks).toEqual([]);
    expect(valid(noRef)).toEqual([]);
  });

  it('FK 추가: 컬럼, 참조 컬럼, PK/UNIQUE 여부, 이름 중복을 본다', () => {
    let m = addColumn(base, 'mst_wh', { name: 'owner_seq', type: 'integer', notNull: false });
    m = addFk(m, 'mst_wh', { name: 'fk_wh_owner', columns: ['owner_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] });
    expect(T(m, 'mst_wh').fks.map(f => f.name)).toEqual(['fk_wh_brand', 'fk_wh_owner']);
    expect(() => addFk(m, 'mst_wh', { name: 'fk_wh_owner', columns: ['owner_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] })).toThrow('이미 있습니다');
    expect(() => addFk(m, 'mst_wh', { name: 'fk_x', columns: ['owner_seq'], refTable: 'mst_brand', refColumns: ['brand_nm'] })).toThrow('PK 나 UNIQUE');
    expect(() => addFk(m, 'mst_wh', { name: 'fk_x', columns: ['nope'], refTable: 'mst_brand', refColumns: ['brand_seq'] })).toThrow('없습니다');
    expect(T(dropFk(m, 'mst_wh', 'fk_wh_owner'), 'mst_wh').fks.map(f => f.name)).toEqual(['fk_wh_brand']);
  });

  it('컬럼 순서 바꾸기', () => {
    expect(T(moveColumn(base, 'mst_wh', 'brand_seq', -1), 'mst_wh').columns.map(c => c.name)).toEqual(['brand_seq', 'wh_seq']);
    expect(moveColumn(base, 'mst_wh', 'wh_seq', -1)).toBe(base);
  });

  it('타입 입력을 리버스 모양으로 맞춘다', () => {
    expect(['INT', 'int8', 'Character Varying( 20 )', 'numeric(10, 2)', 'bool', 'timestamp without time zone'].map(normalizeType))
      .toEqual(['integer', 'bigint', 'varchar(20)', 'numeric(10,2)', 'boolean', 'timestamp']);
  });

  it('수정한 모델과 원래 모델의 차이가 ALTER 대상이 된다', () => {
    let m = addColumn(base, 'mst_wh', { name: 'owner_seq', type: 'integer', notNull: false });
    m = addFk(m, 'mst_wh', { name: 'fk_wh_owner', columns: ['owner_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] });
    expect(diffModels(base, m).map(d => `${d.kind} ${d.change} ${d.name}`)).toEqual(['column add owner_seq', 'fk add fk_wh_owner']);
  });
});

describe('되돌리기, 다시 하기', () => {
  it('수정 직전 모델로 돌아가고 다시 앞으로 간다. 새 수정이 들어오면 다시 하기는 비운다', () => {
    const h = new EditHistory();
    const m1 = addTable(base, 'mst_a');
    h.push(base);
    const m2 = addTable(m1, 'mst_b');
    h.push(m1);
    expect(h.undo(m2)).toBe(m1);
    expect(h.undo(m1)).toBe(base);
    expect(h.undo(base)).toBeUndefined();
    expect(h.redo(base)).toBe(m1);
    h.push(m1);
    expect(h.canRedo).toBe(false);
  });
});

describe('모델 전체 CREATE', () => {
  it('시퀀스, 테이블, 인덱스, FK 순서로 만든다', () => {
    const m = { ...base, sequences: [{ name: 'mst_brand_seq', start: 1, inc: 1 }] };
    const sql = buildCreateAll(m).sql;
    expect(sql.split('\n')[0]).toBe('-- ERD 도구가 만든 전체 CREATE (테이블 2개, FK 1개, 시퀀스 1개, 함수 0개). 빈 스키마에서 실행한다');
    const at = (s: string) => sql.indexOf(s);
    expect(at('CREATE SEQUENCE mst_brand_seq')).toBeLessThan(at('CREATE TABLE mst_brand'));
    expect(at('CREATE TABLE mst_wh')).toBeLessThan(at('CREATE INDEX ix_wh_brand'));
    expect(at('CREATE INDEX ix_wh_brand')).toBeLessThan(at('ADD CONSTRAINT fk_wh_brand'));
    expect(sql).not.toContain('DROP');
  });
});

describe('Oracle 이름 대소문자 (STEP 9)', () => {
  const ora = (): SchemaModel => ({ version: 2, dialect: 'oracle', schema: 'ERD', groups: [{ name: 'erd', isDefault: true }], common: [], sequences: [], functions: [],
    tables: [{ id: 't1', name: 'ERD_P', comment: '', columns: [{ name: 'ID', type: 'integer', notNull: true }, { name: 'mixed', type: 'integer', notNull: false }], pk: ['ID'], fks: [], uniques: [], indexes: [] }] });
  it('새 이름은 대문자로 맞추고, 따옴표가 필요한 이름은 그대로 둔다', () => {
    let m = addTable(ora(), 'erd_c');
    m = addColumn(m, 'erd_c', { name: 'p_id', type: 'int', notNull: false });
    m = addColumn(m, 'ERD_C', { name: 'my-col', type: 'int', notNull: false });
    m = addFk(m, 'erd_c', { name: 'fk_c_p', columns: ['p_id'], refTable: 'erd_p', refColumns: ['id'] });
    const c = m.tables.find(t => t.name === 'ERD_C')!;
    expect(c.columns.map(x => [x.name, x.type])).toEqual([['P_ID', 'integer'], ['my-col', 'integer']]);
    expect(c.fks).toEqual([{ name: 'FK_C_P', columns: ['P_ID'], refTable: 'ERD_P', refColumns: ['ID'] }]);
  });
  it('따옴표로 만든 소문자 이름은 그대로 가리키고, PostgreSQL 모델은 바꾸지 않는다', () => {
    const m = updateColumn(ora(), 'erd_p', 'mixed', { comment: '혼합' });
    expect(m.tables[0].columns[1]).toMatchObject({ name: 'mixed', comment: '혼합' });
    const pg = addTable({ ...ora(), dialect: undefined }, 'erd_c');
    expect(pg.tables.map(t => t.name)).toEqual(['ERD_P', 'erd_c']);
  });
});

describe('Enter 로 컬럼 추가 (STEP 10)', () => {
  it('column_N 은 그 테이블에 없는 첫 번호, NULL 허용 기본 타입으로 공통 컬럼 앞에 들어가고 하나가 되돌리기 한 번이다', () => {
    const h = new EditHistory();
    let m = base;
    for (let i = 0; i < 3; i++) {
      const name = nextColumnName(m, 'mst_brand');
      h.push(m);
      m = addColumn(m, 'mst_brand', { name, type: NEW_COLUMN_TYPE, notNull: false });
    }
    expect(T(m, 'mst_brand').columns.map(c => `${c.name} ${c.type}${c.notNull ? ' NN' : ''}`)).toEqual([
      'brand_seq integer NN', 'brand_nm varchar(100)', 'column_1 varchar(50)', 'column_2 varchar(50)', 'column_3 varchar(50)', 'reg_id varchar(20) NN', 'reg_dt timestamp NN']);
    for (let i = 0; i < 3; i++) m = h.undo(m)!;
    expect(m).toBe(base);
  });
  it('빈 번호를 채우고, 이름 칸 Enter 는 그 컬럼 뒤에 넣는다. Oracle 은 대문자', () => {
    const m = addColumn(base, 'mst_brand', { name: 'column_2', type: 'int', notNull: false });
    expect(nextColumnName(m, 'mst_brand')).toBe('column_1');
    const m2 = addColumn(m, 'mst_brand', { name: nextColumnName(m, 'mst_brand'), type: NEW_COLUMN_TYPE, notNull: false }, 'brand_seq');
    expect(T(m2, 'mst_brand').columns.map(c => c.name).slice(0, 3)).toEqual(['brand_seq', 'column_1', 'brand_nm']);
    const ora: SchemaModel = { ...base, version: 2, dialect: 'oracle', schema: 'ERD' };
    expect(nextColumnName(ora, 'mst_brand')).toBe('COLUMN_1');
  });
});

describe('컬럼 복사, 붙여넣기 (2026-10-16)', () => {
  it('맨 아래에 붙이고 같은 이름은 건너뛴다. PK, IDENTITY 는 옮기지 않고 되돌리기 한 번이다', () => {
    const src = [col('brand_nm', 'varchar(100)', { notNull: true, comment: '사업장명', default: "'x'" }), col('brand_seq', 'integer', { notNull: true, identity: 'always' })];
    const r = pasteColumns(base, 'mst_wh', src);
    expect(r.added).toEqual(['brand_nm']);
    expect(r.skipped).toEqual(['brand_seq']); // mst_wh 에 이미 있다
    expect(T(r.model, 'mst_wh').columns.at(-1)).toEqual(col('brand_nm', 'varchar(100)', { notNull: true, comment: '사업장명', default: "'x'" }));
    expect(T(r.model, 'mst_wh').pk).toEqual(['wh_seq']);
    const n = pasteColumns(base, 'mst_wh', [col('new_id', 'bigint', { identity: 'always', notNull: true })]);
    expect(T(n.model, 'mst_wh').columns.at(-1)).toEqual(col('new_id', 'bigint', { notNull: true }));
  });
});
