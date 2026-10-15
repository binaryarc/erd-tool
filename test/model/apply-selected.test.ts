import { describe, expect, it } from 'vitest';
import { applySelected, mergeModel } from '../../src/shared/model/merge';
import type { SchemaModel, Table } from '../../src/shared/model/types';

const t = (id: string, name: string, cols: string[]): Table => ({
  id, name, comment: '', pk: [], fks: [], uniques: [], indexes: [], columns: cols.map(c => ({ name: c, type: 'int', notNull: false })),
});
const m = (tables: Table[], fn = 'f1'): SchemaModel => ({ version: 1, groups: [], common: [], sequences: [], tables, functions: [{ name: fn, args: '', definition: fn }] });

describe('DB → ERD 골라 받기', () => {
  const prev = m([t('t1', 'a', ['x']), t('t2', 'b', ['x']), t('t3', 'gone', ['x'])], 'old_fn');
  // DB: a 에 컬럼 추가, b 도 바뀜, gone 없어짐, c 새로 생김
  const { model: next } = mergeModel(prev, m([t('', 'a', ['x', 'y']), t('', 'b', ['x', 'z']), t('', 'c', ['x'])], 'new_fn'));

  it('고른 테이블만 DB 것으로 바꾸고 나머지는 지금 모델 그대로', () => {
    const r = applySelected(prev, next, new Set(['a', 'c']), false);
    expect(r.tables.map(x => [x.name, x.id, x.columns.map(c => c.name).join()])).toEqual([
      ['a', 't1', 'x,y'], ['b', 't2', 'x'], ['c', 't4', 'x'], ['gone', 't3', 'x'],
    ]);
    expect(r.functions.map(f => f.name)).toEqual(['old_fn']);
  });

  it('없어진 테이블을 고르면 모델에서도 빠지고, 함수를 고르면 DB 것을 받는다', () => {
    const r = applySelected(prev, next, new Set(['gone']), true);
    expect(r.tables.map(x => x.name)).toEqual(['a', 'b']);
    expect(r.functions.map(f => f.name)).toEqual(['new_fn']);
  });

  it('기존 모델이 없으면 DB 것을 모두 받는다', () => {
    expect(applySelected(null, next, new Set(), false)).toBe(next);
  });
});
