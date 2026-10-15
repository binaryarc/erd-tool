import { describe, expect, it } from 'vitest';
import { arrange, NODE, syncLayout, tableHeight } from '../../src/shared/model/arrange';
import { emptyLayout } from '../../src/shared/model/layout';
import { detectCommon, groupsFromErdGroupsJson } from '../../src/shared/model/groups';
import { isEmptyDiff, mergeModel } from '../../src/shared/model/merge';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';
import { SHOP_GROUPS } from '../helpers/fixtures';

const cols = (n: number): Column[] => Array.from({ length: n }, (_, i) => ({ name: 'c' + i, type: 'integer', notNull: false }));
const table = (id: string, name: string, n = 1, extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns: cols(n), pk: [], fks: [], uniques: [], indexes: [], ...extra });
const model = (tables: Table[]): SchemaModel =>
  ({ version: 1, groups: SHOP_GROUPS, common: [], sequences: [], tables, functions: [] });

describe('배치', () => {
  it('그룹 규칙의 열 수와 간격으로 격자를 만들고, 줄 높이는 그 줄의 가장 높은 테이블', () => {
    const m = model([table('t1', 'mst_a', 3), table('t2', 'mst_b', 10), table('t3', 'mst_c', 1)]);
    const l = emptyLayout();
    const d = syncLayout(m, l);
    d.groups.mdm.rule.cols = 2;
    const { positions } = arrange(m, d);
    const top = positions.get('t1')!.y;
    expect(positions.get('t2')).toEqual({ x: NODE.width + 40, y: top });
    expect(positions.get('t3')).toEqual({ x: 0, y: top + tableHeight(m.tables[1]) + 40 });
  });

  it('새 그룹은 앞 그룹 오른쪽에, 끌어 옮긴 테이블은 그 좌표에 놓는다', () => {
    const m = model([table('t1', 'mst_a'), table('t2', 'whs_a')]);
    const d = syncLayout(m, emptyLayout());
    d.pinned.t2 = [5000, 700];
    const { positions, groups } = arrange(m, d);
    expect(d.groups.wms.rule.origin[0]).toBe(0); // 그룹 규칙 순서(wms 먼저)
    expect(d.groups.mdm.rule.origin[0]).toBeGreaterThan(4 * NODE.width);
    expect(positions.get('t2')).toEqual({ x: 5000, y: 700 });
    expect(groups.map(g => g.name).sort()).toEqual(['mdm', 'wms']);
  });

  it('모델이 바뀌면 없어진 ID 는 순서와 pinned 에서 빼고 새 테이블은 뒤에 붙인다', () => {
    const l = emptyLayout();
    const d = syncLayout(model([table('t1', 'mst_b'), table('t2', 'mst_a')]), l);
    expect(d.groups.mdm.order).toEqual(['t2', 't1']); // 이름순
    d.groups.mdm.order = ['t1', 't2']; // 사람이 바꾼 순서
    d.pinned.t2 = [1, 1];
    syncLayout(model([table('t1', 'mst_b'), table('t3', 'mst_0')]), l);
    expect(d.groups.mdm.order).toEqual(['t1', 't3']);
    expect(d.pinned).toEqual({});
  });
});

describe('리버스 결과 맞추기', () => {
  it('같은 이름 테이블은 ID 를 유지하고 새 테이블은 가장 큰 ID 다음 번호', () => {
    const prev = model([table('t1', 'mst_a'), table('t7', 'mst_b')]);
    const next = model([table('', 'mst_c'), table('', 'mst_b', 2), table('', 'mst_a')]);
    const { model: m, diff } = mergeModel(prev, next);
    expect(m.tables.map(t => [t.name, t.id])).toEqual([['mst_a', 't1'], ['mst_b', 't7'], ['mst_c', 't8']]);
    expect(diff.added).toEqual(['mst_c']);
    expect(diff.changed).toEqual(['mst_b']);
    expect(diff.removed).toEqual([]);
  });

  it('기존 모델이 없으면 이름순으로 t1 부터, 같은 결과를 다시 맞추면 차이가 없다', () => {
    const first = mergeModel(null, model([table('', 'mst_b'), table('', 'mst_a')])).model;
    expect(first.tables.map(t => t.id)).toEqual(['t1', 't2']);
    const again = mergeModel(first, model([table('', 'mst_a'), table('', 'mst_b')]));
    expect(isEmptyDiff(again.diff)).toBe(true);
  });

  it('없어진 테이블과 함수 변화를 목록으로 낸다', () => {
    const prev = { ...model([table('t1', 'mst_a'), table('t2', 'mst_b')]), functions: [{ name: 'f', args: '', definition: 'a' }, { name: 'g', args: '', definition: 'x' }] };
    const next = { ...model([table('', 'mst_a')]), functions: [{ name: 'f', args: '', definition: 'b' }, { name: 'h', args: 'int', definition: 'y' }] };
    const { diff } = mergeModel(prev, next);
    expect(diff.removed).toEqual(['mst_b']);
    expect(diff.functionsChanged).toEqual(['f()']);
    expect(diff.functionsAdded).toEqual(['h(int)']);
    expect(diff.functionsRemoved).toEqual(['g()']);
  });
});

describe('그룹 규칙과 공통 컬럼', () => {
  it('허브 erd-groups.json 을 그룹 규칙으로 바꾼다', () => {
    expect(groupsFromErdGroupsJson({
      grp_rules: [{ prefix: 'whs_', grp: 'wms' }, { prefix: 'mst_', grp: 'mdm' }, { prefix: 'sm_', grp: 'sm' }, { prefix: 'sif_', grp: 'sif' }, { prefix: 'wes_', grp: 'wes' }],
      grp_default: 'sm',
    })).toEqual(SHOP_GROUPS);
  });

  it('여러 테이블 끝에 똑같이 있는 컬럼 묶음을 공통 컬럼으로 고른다', () => {
    const common: Column[] = [{ name: 'reg_id', type: 'varchar(20)', notNull: true }, { name: 'reg_dt', type: 'timestamp', notNull: true, default: 'now()' }];
    // 앞 컬럼은 테이블마다 다르게 둔다
    const own = (i: number): Column[] => [{ name: `own_${i}`, type: 'integer', notNull: true }];
    const tables = Array.from({ length: 12 }, (_, i) => table('t' + i, 'mst_' + i, 0, { columns: [...own(i), ...common] }));
    tables.push(table('x', 'mst_x', 0, { columns: [...own(99), { ...common[0], type: 'varchar(50)' }, common[1]] }));
    expect(detectCommon(tables)).toEqual(common);
    expect(detectCommon(tables.slice(0, 5))).toEqual([]); // 10개 미만이면 고르지 않음
  });
});
