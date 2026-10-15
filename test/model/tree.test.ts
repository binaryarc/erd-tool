import { describe, expect, it } from 'vitest';
import { arrangeTree, components, neighborhood } from '../../src/shared/model/tree';
import type { SchemaModel, Table } from '../../src/shared/model/types';

const t = (id: string, name: string, refs: string[] = [], rows = 3): Table => ({
  id, name, comment: '', pk: [], uniques: [], indexes: [],
  columns: Array.from({ length: rows }, (_, i) => ({ name: 'c' + i, type: 'int', notNull: false })),
  fks: refs.map((r, i) => ({ name: `${name}_fk${i}`, columns: ['c0'], refTable: r, refColumns: ['c0'] })),
});
const model = (tables: Table[]): SchemaModel => ({ version: 1, groups: [], common: [], sequences: [], functions: [], tables });
const size = { width: () => 200, height: (x: Table) => 24 + x.columns.length * 18 };

// biz ← center ← wh,   biz ← user,   log (홀로),   code (홀로)
const m = model([
  t('t1', 'mst_biz'), t('t2', 'mst_center', ['mst_biz']), t('t3', 'mst_wh', ['mst_center']),
  t('t4', 'mst_user', ['mst_biz']), t('t5', 'sm_log'), t('t6', 'sm_code'), t('t7', 'self_ref', ['self_ref']),
]);

describe('트리 배치', () => {
  it('FK 로 이어진 묶음을 큰 것부터 나눈다 (자기 참조는 잇지 않는다)', () => {
    expect(components(m).map(c => c.map(x => x.name))).toEqual([
      ['mst_biz', 'mst_center', 'mst_user', 'mst_wh'], ['self_ref'], ['sm_code'], ['sm_log'],
    ]);
  });

  it('참조되는 테이블(부모)이 참조하는 테이블(자식)보다 위에 놓인다', () => {
    const p = arrangeTree(m, size);
    expect(p.get('t1')!.y).toBeLessThan(p.get('t2')!.y);
    expect(p.get('t2')!.y).toBeLessThan(p.get('t3')!.y);
    expect(p.get('t1')!.y).toBeLessThan(p.get('t4')!.y);
  });

  it('FK 없는 테이블은 묶음 아래에 모으고, 어떤 두 테이블도 겹치지 않는다', () => {
    const p = arrangeTree(m, size);
    const treeBottom = Math.max(...['t1', 't2', 't3', 't4'].map(id => p.get(id)!.y + size.height(m.tables.find(x => x.id === id)!)));
    for (const id of ['t5', 't6', 't7']) expect(p.get(id)!.y).toBeGreaterThan(treeBottom);
    const boxes = m.tables.map(x => ({ ...p.get(x.id)!, w: 200, h: size.height(x) }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap, `${m.tables[i].name} 와 ${m.tables[j].name} 가 겹침`).toBe(false);
    }
  });

  it('같은 모델은 항상 같은 좌표', () => {
    expect([...arrangeTree(m, size)]).toEqual([...arrangeTree(m, size)]);
  });
});

describe('바로 이어진 테이블', () => {
  it('참조하는 쪽과 참조되는 쪽을 모두 담고, 바깥으로 가는 FK 는 뺀다', () => {
    const n = neighborhood(m, 'mst_center');
    expect(n.tables.map(x => x.name).sort()).toEqual(['mst_biz', 'mst_center', 'mst_wh']);
    expect(n.tables.flatMap(x => x.fks.map(f => `${x.name}>${f.refTable}`)).sort()).toEqual(['mst_center>mst_biz', 'mst_wh>mst_center']);
  });
});
