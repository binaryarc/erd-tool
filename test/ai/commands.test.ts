import { describe, expect, it } from 'vitest';
import { CommandError, MAX_COMMANDS, applyCommands } from '../../src/shared/ai/commands';
import { findSpotNear } from '../../src/shared/ai/place';
import { overview, tablesText, viewStateText, type Box } from '../../src/shared/ai/notation';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const common = [col('reg_id', 'varchar(20)', { notNull: true }), col('reg_dt', 'timestamp', { notNull: true, default: 'now()' })];
const model: SchemaModel = {
  version: 1, common, sequences: [], functions: [],
  groups: [{ name: 'mdm', prefix: 'mst_' }, { name: 'sm', prefix: 'sm_', isDefault: true }],
  tables: [
    table('t1', 'mst_biz', [col('biz_seq', 'integer', { notNull: true, comment: '사업장' }), ...common], { pk: ['biz_seq'], comment: 'MST_사업장' }),
    table('t2', 'mst_biz_wh', [col('biz_seq', 'integer', { notNull: true }), col('wh_seq', 'integer', { notNull: true }), col('use_yn', 'char(1)', { notNull: true, default: "'Y'" })], {
      pk: ['biz_seq', 'wh_seq'], comment: '사업장별 창고', fks: [{ name: 'fk_bw_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] }],
    }),
    table('t3', 'mst_biz_center', [col('biz_seq', 'integer', { notNull: true })], { comment: '사업장 센터' }),
  ],
};

describe('AI 에게 주는 글', () => {
  it('개요: 그룹마다 한 줄, 공통 컬럼 정의', () => {
    expect(overview(model)).toBe([
      '테이블 3, FK 1, 그룹 2. 자세한 구조는 erd_tables 로 필요한 테이블만 묻는다',
      "+common = reg_id varchar(20) NN, reg_dt timestamp NN =now()",
      'mdm (mst_) 3: mst_biz, mst_biz_center, mst_biz_wh',
    ].join('\n'));
  });
  it('한 줄 표기: +common 줄임, FK 는 코멘트 앞에 FK>, 복합 PK 줄, 없는 테이블 알림', () => {
    expect(tablesText(model, ['mst_biz', 'mst_biz_wh', 'nope'])).toBe([
      'mst_biz [mdm] MST_사업장 +common',
      '  biz_seq integer PK #사업장',
      'mst_biz_wh [mdm] 사업장별 창고',
      '  biz_seq integer NN FK>mst_biz.biz_seq',
      '  wh_seq integer NN',
      "  use_yn char(1) NN ='Y'",
      '  PK (biz_seq, wh_seq)',
      '없는 테이블: nope',
    ].join('\n'));
  });
  it('화면 배치: 격자 행, 고정 테이블은 가장 가까운 테이블 기준, 겹침 수', () => {
    const d = { mode: 'grid' as const, groups: { mdm: { rule: { cols: 2, gap: 40, origin: [0, 0] as [number, number] }, order: ['t1', 't3', 't2'] } }, pinned: { t2: [300, 0] as [number, number] } };
    const boxes = new Map<string, Box>([['t1', { x: 0, y: 0, w: 200, h: 100 }], ['t3', { x: 0, y: 140, w: 200, h: 40 }], ['t2', { x: 300, y: 0, w: 200, h: 80 }]]);
    expect(viewStateText(model, d, boxes, 0.85, '전체')).toBe([
      '다이어그램 전체: 그룹 격자 배치, 확대 85%',
      '그룹 mdm: 격자 2열 간격 40',
      '  1행: mst_biz, mst_biz_center',
      '  2행: mst_biz_wh(고정됨)',
      '고정: mst_biz_wh (mst_biz 의 오른쪽)',
      '겹친 테이블 쌍: 0',
    ].join('\n'));
  });
});

describe('변경 명령', () => {
  it('완료 기준 문장: 컬럼 추가와 옆에 두기', () => {
    const r = applyCommands(model, ['add_column mst_biz_wh.sort_no int NN =0 #정렬 순서', 'place mst_biz_wh after=mst_biz_center group=MDM']);
    expect(r.model.tables[1].columns.at(-1)).toEqual({ name: 'sort_no', type: 'integer', notNull: true, default: '0', comment: '정렬 순서' });
    expect(r.places).toEqual([{ table: 'mst_biz_wh', after: 'mst_biz_center' }]);
  });
  it('설계 10-4 예시 명령과 나머지 명령', () => {
    const r = applyCommands(model, [
      'add_table mst_wh +common #창고',
      'add_column mst_wh.wh_seq integer PK',
      'rename mst_biz_wh.use_yn -> del_yn',
      'add_fk mst_biz_wh.wh_seq -> mst_wh.wh_seq',
      'alter_column mst_biz_wh.del_yn char(1) NN',
      'comment mst_biz_center #사업장별 센터',
      'comment mst_biz.biz_seq #사업장 순번',
    ]);
    const wh = r.model.tables.find(t => t.name === 'mst_wh')!;
    expect(wh.columns.map(c => c.name)).toEqual(['wh_seq', 'reg_id', 'reg_dt']);
    const bw = r.model.tables.find(t => t.name === 'mst_biz_wh')!;
    expect(bw.fks.map(f => f.name)).toEqual(['fk_bw_biz', 'fk_mst_biz_wh_mst_wh']);
    expect(bw.columns[2]).toEqual({ name: 'del_yn', type: 'char(1)', notNull: true });
    expect(r.model.tables.find(t => t.name === 'mst_biz_center')!.comment).toBe('사업장별 센터');
    expect(r.model.tables[0].columns[0].comment).toBe('사업장 순번');
  });
  it('하나라도 실패하면 전체를 적용하지 않는다 (줄 번호와 이유)', () => {
    const before = JSON.stringify(model);
    expect(() => applyCommands(model, ['add_column mst_biz.memo text', 'add_column nope.x int'])).toThrow(/2줄 「add_column nope\.x int」: 테이블 nope 이 없다/);
    expect(JSON.stringify(model)).toBe(before);
    expect(() => applyCommands(model, ['place mst_biz_wh 100 200'])).toThrow('좌표는 받지 않는다');
    expect(() => applyCommands(model, ['place mst_biz_wh after=mst_biz group=sm'])).toThrow('그룹은 mdm');
    expect(() => applyCommands(model, ['explode mst_biz'])).toThrow(CommandError);
    expect(() => applyCommands(model, Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => `add_column mst_biz.c${i} int`))).toThrow('50줄까지');
  });
});

describe('빈 곳에 고정', () => {
  const boxes = new Map<string, Box>([
    ['center', { x: 0, y: 0, w: 200, h: 100 }], ['right', { x: 240, y: 0, w: 200, h: 300 }], ['moving', { x: 0, y: 400, w: 200, h: 120 }],
  ]);
  it('오른쪽이 비면 그 자리', () => {
    expect(findSpotNear(new Map([['center', boxes.get('center')!]]), 'center', 'moving', { w: 200, h: 120 })).toEqual({ x: 240, y: 0 });
  });
  it('오른쪽이 차 있으면 다른 테이블과 겹치지 않는 가장 가까운 자리', () => {
    const p = findSpotNear(boxes, 'center', 'moving', { w: 200, h: 120 });
    for (const [id, b] of boxes) {
      if (id === 'moving') continue;
      expect(p.x + 200 <= b.x || b.x + b.w <= p.x || p.y + 120 <= b.y || b.y + b.h <= p.y).toBe(true);
    }
    expect(Math.hypot(p.x - 240, p.y)).toBeLessThan(400);
  });
});
