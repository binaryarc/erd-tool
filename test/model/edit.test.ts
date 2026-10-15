import { describe, expect, it } from 'vitest';
import {
  EditError, EditHistory, addColumn, addFk, addTable, dropColumn, dropFk, dropTable, moveColumn, normalizeType, updateColumn, updateTable,
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
  version: 1, groups: [{ name: 'mdm', prefix: 'mst_', isDefault: true }], common, sequences: [], functions: [],
  tables: [
    table('t1', 'mst_biz', [col('biz_seq', 'integer', { notNull: true }), col('biz_nm', 'varchar(100)'), ...common], { pk: ['biz_seq'] }),
    table('t3', 'mst_wh', [col('wh_seq', 'integer', { notNull: true }), col('biz_seq', 'integer')], {
      pk: ['wh_seq'], fks: [{ name: 'fk_wh_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] }],
      indexes: [{ name: 'ix_wh_biz', columns: ['biz_seq'], unique: false }], uniques: [{ name: 'uq_wh', columns: ['wh_seq', 'biz_seq'] }],
    }),
  ],
};
const T = (m: SchemaModel, n: string) => m.tables.find(t => t.name === n)!;
const valid = (m: SchemaModel) => validateModel(parseModel(serializeModel(m)));

describe('ERD 수정 명령', () => {
  it('테이블 추가: 다음 ID, 공통 컬럼 넣기, 이름 중복 막기', () => {
    const m = addTable(base, 'mst_center', { comment: '센터', withCommon: true });
    expect(T(m, 'mst_center')).toMatchObject({ id: 't4', comment: '센터', columns: common });
    expect(() => addTable(m, 'mst_biz')).toThrow(EditError);
    expect(() => addTable(m, ' ')).toThrow(EditError);
    expect(base.tables).toHaveLength(2); // 원래 모델은 그대로
  });

  it('컬럼 추가는 공통 컬럼 앞에 들어가 +common 저장이 유지된다', () => {
    const m = addColumn(base, 'mst_biz', { name: 'sort_no', type: 'INT', notNull: true, default: '0' });
    expect(T(m, 'mst_biz').columns.map(c => c.name)).toEqual(['biz_seq', 'biz_nm', 'sort_no', 'reg_id', 'reg_dt']);
    expect(T(m, 'mst_biz').columns[2]).toEqual({ name: 'sort_no', type: 'integer', notNull: true, default: '0' });
    expect(serializeModel(m)['mdm.erd']).toContain('mst_biz @t1 +common');
    expect(addColumn(base, 'mst_wh', { name: 'x', type: 'text', notNull: false }, 'wh_seq').tables[1].columns.map(c => c.name)).toEqual(['wh_seq', 'x', 'biz_seq']);
    expect(() => addColumn(base, 'mst_biz', { name: 'biz_nm', type: 'text', notNull: false })).toThrow('이미 있다');
  });

  it('PK 로 고르면 NOT NULL 도 켠다', () => {
    const m = addColumn(base, 'mst_wh', { name: 'center_seq', type: 'integer', notNull: false, pk: true });
    expect(T(m, 'mst_wh').pk).toEqual(['wh_seq', 'center_seq']);
    expect(T(m, 'mst_wh').columns.at(-1)!.notNull).toBe(true);
    const off = updateColumn(m, 'mst_wh', 'center_seq', { pk: false });
    expect(T(off, 'mst_wh').pk).toEqual(['wh_seq']);
  });

  it('컬럼 이름 바꾸기는 PK, 자기 FK, UNIQUE, 인덱스, 다른 테이블의 FK 참조를 함께 고친다', () => {
    const m1 = updateColumn(base, 'mst_wh', 'biz_seq', { name: 'biz_no' });
    expect(T(m1, 'mst_wh').fks[0].columns).toEqual(['biz_no']);
    expect(T(m1, 'mst_wh').indexes[0].columns).toEqual(['biz_no']);
    expect(T(m1, 'mst_wh').uniques[0].columns).toEqual(['wh_seq', 'biz_no']);
    const m2 = updateColumn(base, 'mst_biz', 'biz_seq', { name: 'biz_id', comment: '사업장 ID' });
    expect(T(m2, 'mst_biz').pk).toEqual(['biz_id']);
    expect(T(m2, 'mst_wh').fks[0].refColumns).toEqual(['biz_id']);
    expect(T(m2, 'mst_biz').columns[0]).toEqual({ name: 'biz_id', type: 'integer', notNull: true, comment: '사업장 ID' });
    expect(valid(m2)).toEqual([]);
  });

  it('컬럼 고치기: 빈 기본값과 빈 코멘트는 없는 것으로', () => {
    const m = updateColumn(base, 'mst_biz', 'reg_dt', { default: '', comment: '' });
    expect(T(m, 'mst_biz').columns.at(-1)).toEqual({ name: 'reg_dt', type: 'timestamp', notNull: true });
  });

  it('테이블 이름 바꾸기는 ID 를 지키고 다른 테이블의 FK 참조를 고친다', () => {
    const m = updateTable(base, 'mst_biz', { name: 'mst_company', comment: '회사' });
    expect(T(m, 'mst_company')).toMatchObject({ id: 't1', comment: '회사' });
    expect(T(m, 'mst_wh').fks[0].refTable).toBe('mst_company');
    expect(() => updateTable(base, 'mst_biz', { name: 'mst_wh' })).toThrow('이미 있다');
  });

  it('지우기는 그 대상을 가리키는 키를 함께 지운다', () => {
    const noBiz = dropTable(base, 'mst_biz');
    expect(T(noBiz, 'mst_wh').fks).toEqual([]);
    const noCol = dropColumn(base, 'mst_wh', 'biz_seq');
    expect(T(noCol, 'mst_wh')).toMatchObject({ fks: [], indexes: [], uniques: [], pk: ['wh_seq'] });
    const noRef = dropColumn(base, 'mst_biz', 'biz_seq');
    expect(T(noRef, 'mst_biz').pk).toEqual([]);
    expect(T(noRef, 'mst_wh').fks).toEqual([]);
    expect(valid(noRef)).toEqual([]);
  });

  it('FK 추가: 컬럼, 참조 컬럼, PK/UNIQUE 여부, 이름 중복을 본다', () => {
    let m = addColumn(base, 'mst_wh', { name: 'owner_seq', type: 'integer', notNull: false });
    m = addFk(m, 'mst_wh', { name: 'fk_wh_owner', columns: ['owner_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] });
    expect(T(m, 'mst_wh').fks.map(f => f.name)).toEqual(['fk_wh_biz', 'fk_wh_owner']);
    expect(() => addFk(m, 'mst_wh', { name: 'fk_wh_owner', columns: ['owner_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] })).toThrow('이미 있다');
    expect(() => addFk(m, 'mst_wh', { name: 'fk_x', columns: ['owner_seq'], refTable: 'mst_biz', refColumns: ['biz_nm'] })).toThrow('PK 나 UNIQUE');
    expect(() => addFk(m, 'mst_wh', { name: 'fk_x', columns: ['nope'], refTable: 'mst_biz', refColumns: ['biz_seq'] })).toThrow('없다');
    expect(T(dropFk(m, 'mst_wh', 'fk_wh_owner'), 'mst_wh').fks.map(f => f.name)).toEqual(['fk_wh_biz']);
  });

  it('컬럼 순서 바꾸기', () => {
    expect(T(moveColumn(base, 'mst_wh', 'biz_seq', -1), 'mst_wh').columns.map(c => c.name)).toEqual(['biz_seq', 'wh_seq']);
    expect(moveColumn(base, 'mst_wh', 'wh_seq', -1)).toBe(base);
  });

  it('타입 입력을 리버스 모양으로 맞춘다', () => {
    expect(['INT', 'int8', 'Character Varying( 20 )', 'numeric(10, 2)', 'bool', 'timestamp without time zone'].map(normalizeType))
      .toEqual(['integer', 'bigint', 'varchar(20)', 'numeric(10,2)', 'boolean', 'timestamp']);
  });

  it('수정한 모델과 원래 모델의 차이가 ALTER 대상이 된다', () => {
    let m = addColumn(base, 'mst_wh', { name: 'owner_seq', type: 'integer', notNull: false });
    m = addFk(m, 'mst_wh', { name: 'fk_wh_owner', columns: ['owner_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] });
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
    const m = { ...base, sequences: [{ name: 'mst_biz_seq', start: 1, inc: 1 }] };
    const sql = buildCreateAll(m).sql;
    expect(sql.split('\n')[0]).toBe('-- ERD 도구가 만든 전체 CREATE (테이블 2개, FK 1개, 시퀀스 1개, 함수 0개). 빈 스키마에서 실행한다');
    const at = (s: string) => sql.indexOf(s);
    expect(at('CREATE SEQUENCE mst_biz_seq')).toBeLessThan(at('CREATE TABLE mst_biz'));
    expect(at('CREATE TABLE mst_wh')).toBeLessThan(at('CREATE INDEX ix_wh_biz'));
    expect(at('CREATE INDEX ix_wh_biz')).toBeLessThan(at('ADD CONSTRAINT fk_wh_biz'));
    expect(sql).not.toContain('DROP');
  });
});
