import { describe, expect, it } from 'vitest';
import {
  TabError, addMembers, createTab, deleteTab, forgetIds, groupTabs, groupView, newTabName, prefixTabs, pruneMembers, removeMembers, renameTab,
} from '../../src/shared/model/group-tabs';
import { emptyLayout, parseLayout, serializeLayout } from '../../src/shared/model/layout';
import { dropTable } from '../../src/shared/model/edit';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string): Column => ({ name, type: 'integer', notNull: true });
const table = (id: string, name: string, extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns: [col(name.split('_').pop() + '_seq')], pk: [name.split('_').pop() + '_seq'], fks: [], uniques: [], indexes: [], ...extra });
const fk = (name: string, column: string, refTable: string, refColumn: string) => ({ name, columns: [column], refTable, refColumns: [refColumn] });

// mst_biz ← mst_wh ← whs_stock (wms 그룹에서 mst_wh 로 가는 FK), sm_user 는 혼자
const model: SchemaModel = {
  version: 2, groups: [{ name: 'mdm', prefix: 'mst_' }, { name: 'wms', prefix: 'whs_' }, { name: 'sm', prefix: 'sm_', isDefault: true }],
  common: [], sequences: [], functions: [],
  tables: [
    table('t1', 'mst_biz'),
    table('t2', 'mst_wh', { columns: [col('wh_seq'), col('biz_seq')], fks: [fk('fk_wh_biz', 'biz_seq', 'mst_biz', 'biz_seq')] }),
    table('t3', 'whs_stock', { columns: [col('stock_seq'), col('wh_seq')], fks: [fk('fk_stock_wh', 'wh_seq', 'mst_wh', 'wh_seq')] }),
    table('t4', 'sm_user'),
  ],
};

describe('그룹 탭 (STEP 10)', () => {
  it('그룹 탭 화면은 소속 테이블만 두고, 밖으로 이어진 FK 는 양쪽 테이블에 적는다', () => {
    const v = groupView(model, ['t2', 't3']);
    expect(v.model.tables.map(t => t.name)).toEqual(['mst_wh', 'whs_stock']);
    expect(v.model.tables.find(t => t.id === 't2')!.fks.map(f => f.name)).toEqual(['fk_wh_biz']); // FK 배지는 남는다 (선은 캔버스가 그리지 않는다)
    expect(Object.fromEntries(v.external)).toEqual({ t2: ['→ mst_biz (fk_wh_biz)'] });
    expect(Object.fromEntries(groupView(model, ['t1']).external)).toEqual({ t1: ['← mst_wh (fk_wh_biz)'] });
  });

  it('탭 만들기, 이름 바꾸기, 지우기. 「전체」 와 같은 이름은 막는다', () => {
    const l = emptyLayout();
    createTab(l, newTabName(l), ['t1']);
    createTab(l, newTabName(l));
    expect(groupTabs(l)).toEqual(['그룹 1', '그룹 2']);
    renameTab(l, '그룹 1', '기준정보');
    expect(groupTabs(l)).toEqual(['기준정보', '그룹 2']);
    expect(l.diagrams['기준정보'].members).toEqual(['t1']);
    expect(() => renameTab(l, '그룹 2', '기준정보')).toThrow(TabError);
    expect(() => createTab(l, '전체')).toThrow(TabError);
    deleteTab(l, '기준정보');
    expect(groupTabs(l)).toEqual(['그룹 2']);
    deleteTab(l, '그룹 2');
    expect(l.tabs).toBeUndefined();
  });

  it('한 테이블이 두 그룹에 들어가고 위치는 탭마다 따로다. 빼면 그 탭의 위치도 지운다', () => {
    const l = emptyLayout();
    createTab(l, 'A', ['t1', 't2']);
    createTab(l, 'B', ['t2']);
    expect(addMembers(l, 'B', ['t2', 't3', 't3'])).toEqual(['t3']);
    l.diagrams.A.pinned.t2 = [10, 20];
    l.diagrams.B.pinned.t2 = [500, 600];
    removeMembers(l, 'A', ['t2']);
    expect(l.diagrams.A).toMatchObject({ members: ['t1'], pinned: {} });
    expect(l.diagrams.B).toMatchObject({ members: ['t2', 't3'], pinned: { t2: [500, 600] } });
  });

  it('지운 테이블의 소속은 저장할 때 정리한다. 새 테이블 ID 가 다시 쓰이면 다른 그룹 소속에서 먼저 뺀다', () => {
    const l = emptyLayout();
    createTab(l, 'A', ['t1', 't4']);
    const m = dropTable(model, 'sm_user');
    expect(l.diagrams.A.members).toEqual(['t1', 't4']); // 되돌리기로 돌아오면 소속도 돌아오게 남겨 둔다
    forgetIds(l, ['t4']); // 새 테이블이 t4 를 받았다
    expect(l.diagrams.A.members).toEqual(['t1']);
    createTab(l, 'B', ['t9']);
    pruneMembers(l, m);
    expect(l.diagrams.B.members).toEqual([]);
  });

  it('접두어 그룹마다 탭을 만들고 이미 있는 이름은 건너뛴다', () => {
    const l = emptyLayout();
    createTab(l, 'wms', []);
    expect(prefixTabs(l, model)).toEqual(['mdm', 'sm']);
    expect(l.diagrams.mdm.members).toEqual(['t1', 't2']);
    expect(l.diagrams.sm.members).toEqual(['t4']);
    expect(groupTabs(l)).toEqual(['wms', 'mdm', 'sm']);
  });

  it('layout.json 으로 저장하고 다시 읽어도 탭 순서, 소속, 위치가 같다. 탭이 없으면 예전 모양 그대로다', () => {
    const l = emptyLayout();
    l.diagrams['전체'] = { groups: {}, pinned: {} };
    const plain = serializeLayout(l);
    expect(plain).not.toContain('tabs');
    createTab(l, '출고', ['t3', 't2']);
    createTab(l, '기준', ['t1']);
    l.diagrams['출고'].pinned.t3 = [1, 2];
    const text = serializeLayout(l);
    const back = parseLayout(text);
    expect(groupTabs(back)).toEqual(['출고', '기준']);
    expect(back.diagrams['출고']).toMatchObject({ members: ['t3', 't2'], pinned: { t3: [1, 2] } });
    expect(serializeLayout(back)).toBe(text);
  });
});
