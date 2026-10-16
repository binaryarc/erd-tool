import { describe, expect, it } from 'vitest';
import { applyConnect, planConnect } from '../../src/shared/model/connect';
import { EditHistory } from '../../src/shared/model/edit';
import { diffModels } from '../../src/shared/model/diff';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type = 'integer', notNull = true): Column => ({ name, type, notNull });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });

const model: SchemaModel = {
  version: 2, groups: [{ name: 'mdm', isDefault: true }], common: [], sequences: [], functions: [],
  tables: [
    table('t1', 'mst_biz', [col('biz_seq'), col('biz_cd', 'varchar(20)')], { pk: ['biz_seq'], uniques: [{ name: 'uq_biz_cd', columns: ['biz_cd'] }] }),
    table('t2', 'mst_wh', [col('wh_seq'), col('biz_seq', 'integer', false), col('owner_seq', 'integer', false)], { pk: ['wh_seq'] }),
    table('t3', 'mst_biz_wh', [col('biz_seq'), col('wh_seq')], { pk: ['biz_seq', 'wh_seq'] }),
    table('t4', 'mst_memo', [col('memo_seq')], { pk: ['memo_seq'] }),
    table('t5', 'mst_log', [col('log_txt', 'text')]),
  ],
};
const ok = (p: ReturnType<typeof planConnect>) => { if (!p.ok) throw new Error(p.error); return p; };

describe('선 연결로 FK 만들기 (STEP 10)', () => {
  it('부모는 PK 쪽으로 정한다. 어느 쪽에서 끌어도 같다', () => {
    for (const [a, b] of [[{ table: 'mst_biz', column: 'biz_seq' }, { table: 'mst_wh', column: 'biz_seq' }], [{ table: 'mst_wh', column: 'biz_seq' }, { table: 'mst_biz', column: 'biz_seq' }]]) {
      const p = ok(planConnect(model, a, b));
      expect(p).toMatchObject({ parent: 'mst_biz', parentColumn: 'biz_seq', child: 'mst_wh', childColumn: 'biz_seq', fkName: 'fk_mst_wh_mst_biz' });
    }
  });

  it('자식 컬럼 처음 값: 같은 이름 → 놓은 컬럼(타입 같음) → 새 컬럼', () => {
    expect(ok(planConnect(model, { table: 'mst_biz', column: 'biz_seq' }, { table: 'mst_wh', column: 'owner_seq' })).childColumn).toBe('biz_seq');
    expect(ok(planConnect(model, { table: 'mst_memo', column: 'memo_seq' }, { table: 'mst_wh', column: 'owner_seq' })).childColumn).toBe('owner_seq');
    expect(ok(planConnect(model, { table: 'mst_memo' }, { table: 'mst_log' }))).toMatchObject({ childColumn: null, newColumn: 'memo_seq', parentType: 'integer' });
    // UNIQUE 컬럼도 부모 키가 된다
    expect(ok(planConnect(model, { table: 'mst_log', column: 'log_txt' }, { table: 'mst_biz', column: 'biz_cd' }))).toMatchObject({ parent: 'mst_biz', parentColumn: 'biz_cd', childColumn: null });
  });

  it('자식에 컬럼이 없으면 NULL 허용 새 컬럼과 FK 를 한 번에 만들고, 되돌리기 한 번으로 돌아간다', () => {
    const p = ok(planConnect(model, { table: 'mst_memo' }, { table: 'mst_log' }));
    const h = new EditHistory();
    h.push(model);
    const m = applyConnect(model, p, { fkName: p.fkName, childColumn: null, onDelete: 'cascade' });
    const log = m.tables.find(t => t.name === 'mst_log')!;
    expect(log.columns.at(-1)).toEqual({ name: 'memo_seq', type: 'integer', notNull: false });
    expect(log.fks).toEqual([{ name: 'fk_mst_log_mst_memo', columns: ['memo_seq'], refTable: 'mst_memo', refColumns: ['memo_seq'], onDelete: 'cascade' }]);
    expect(diffModels(model, m).map(d => `${d.kind} ${d.change} ${d.name}`)).toEqual(['column add memo_seq', 'fk add fk_mst_log_mst_memo']);
    expect(h.undo(m)).toBe(model);
  });

  it('부모가 복합 PK 면 오류로 안내하고, 키가 없으면 막는다', () => {
    const c = planConnect(model, { table: 'mst_biz_wh' }, { table: 'mst_log' });
    expect(c).toMatchObject({ ok: false, composite: true });
    expect(planConnect(model, { table: 'mst_biz_wh', column: 'wh_seq' }, { table: 'mst_log', column: 'log_txt' })).toMatchObject({ ok: false, composite: true });
    expect(planConnect(model, { table: 'mst_log', column: 'log_txt' }, { table: 'mst_wh', column: 'owner_seq' })).toMatchObject({ ok: false });
    expect(planConnect(model, { table: 'mst_wh' }, { table: 'mst_wh' })).toMatchObject({ ok: false });
  });

  it('자기 참조: 같은 테이블의 다른 컬럼에서 PK 로', () => {
    const p = ok(planConnect(model, { table: 'mst_wh', column: 'owner_seq' }, { table: 'mst_wh', column: 'wh_seq' }));
    expect(p).toMatchObject({ parent: 'mst_wh', parentColumn: 'wh_seq', child: 'mst_wh', childColumn: 'owner_seq' });
  });
});
