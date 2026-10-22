import { describe, expect, it } from 'vitest';
import { CommandError, MAX_COMMANDS, applyCommands } from '../../src/shared/ai/commands';
import { findSpotNear } from '../../src/shared/ai/place';
import { diffText, overview, tablesText, viewStateText, type Box } from '../../src/shared/ai/notation';
import { diffModels } from '../../src/shared/model/diff';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const common = [col('reg_id', 'varchar(20)', { notNull: true }), col('reg_dt', 'timestamp', { notNull: true, default: 'now()' })];
const model: SchemaModel = {
  version: 1, common, sequences: [], functions: [],
  groups: [{ name: 'mst', prefix: 'mst_' }, { name: 'sys', prefix: 'sys_', isDefault: true }],
  tables: [
    table('t1', 'mst_brand', [col('brand_seq', 'integer', { notNull: true, comment: '사업장' }), ...common], { pk: ['brand_seq'], comment: 'MST_사업장' }),
    table('t2', 'mst_brand_wh', [col('brand_seq', 'integer', { notNull: true }), col('wh_seq', 'integer', { notNull: true }), col('use_yn', 'char(1)', { notNull: true, default: "'Y'" })], {
      pk: ['brand_seq', 'wh_seq'], comment: '사업장별 창고', fks: [{ name: 'fk_bw_brand', columns: ['brand_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] }],
    }),
    table('t3', 'mst_brand_center', [col('brand_seq', 'integer', { notNull: true })], { comment: '사업장 센터' }),
  ],
};

describe('AI 에게 주는 글', () => {
  it('개요: 그룹마다 한 줄, 공통 컬럼 정의', () => {
    expect(overview(model)).toBe([
      '테이블 3, FK 1, 그룹 2. 자세한 구조는 erd_tables 로 필요한 테이블만 묻는다',
      "+common = reg_id varchar(20) NN, reg_dt timestamp NN =now()",
      'mst (mst_) 3: mst_brand, mst_brand_center, mst_brand_wh',
    ].join('\n'));
  });
  it('한 줄 표기: +common 줄임, FK 는 코멘트 앞에 FK>, 복합 PK 줄, 없는 테이블 알림', () => {
    expect(tablesText(model, ['mst_brand', 'mst_brand_wh', 'nope'])).toBe([
      'mst_brand [mst] MST_사업장 +common',
      '  brand_seq integer PK #사업장',
      'mst_brand_wh [mst] 사업장별 창고',
      '  brand_seq integer NN FK>mst_brand.brand_seq',
      '  wh_seq integer NN',
      "  use_yn char(1) NN ='Y'",
      '  PK (brand_seq, wh_seq)',
      '없는 테이블: nope',
    ].join('\n'));
  });
  it('화면 배치: 격자 행, 고정 테이블은 가장 가까운 테이블 기준, 겹침 수', () => {
    const d = { mode: 'grid' as const, groups: { mst: { rule: { cols: 2, gap: 40, origin: [0, 0] as [number, number] }, order: ['t1', 't3', 't2'] } }, pinned: { t2: [300, 0] as [number, number] } };
    const boxes = new Map<string, Box>([['t1', { x: 0, y: 0, w: 200, h: 100 }], ['t3', { x: 0, y: 140, w: 200, h: 40 }], ['t2', { x: 300, y: 0, w: 200, h: 80 }]]);
    expect(viewStateText(model, d, boxes, 0.85, '전체')).toBe([
      '다이어그램 전체: 그룹 격자 배치, 확대 85%',
      '그룹 mst: 격자 2열 간격 40',
      '  1행: mst_brand, mst_brand_center',
      '  2행: mst_brand_wh(고정됨)',
      '고정: mst_brand_wh (mst_brand 의 오른쪽)',
      '겹친 테이블 쌍: 0',
    ].join('\n'));
  });
});

describe('두 구조 비교 글 (db_compare)', () => {
  it('요약, 차이 목록, 위험, 같으면 차이 0, 많으면 앞부분만', () => {
    const changed = applyCommands(model, ['add_column mst_brand.memo text', 'drop_column mst_brand_wh.use_yn']).model;
    expect(diffText(diffModels(model, changed), 'dev', '지금 ERD')).toBe([
      'dev 을(를) 지금 ERD 처럼 바꾸려면: 차이 2개, 위험 1개',
      '요약: 컬럼 추가 1, 컬럼 삭제 1',
      '1. 컬럼 추가 mst_brand.memo: text',
      '2. 컬럼 삭제 mst_brand_wh.use_yn: char(1) [위험: 컬럼 값이 사라집니다]',
    ].join('\n'));
    expect(diffText([], 'dev', 'test')).toBe('dev 와(과) test 는 구조가 같다 (차이 0)');
    const many = applyCommands(model, Array.from({ length: 5 }, (_, i) => `add_column mst_brand.c${i} int`)).model;
    expect(diffText(diffModels(model, many), 'a', 'b', 2).split('\n').at(-1)).toBe('(앞 2개만 보임. kind 로 종류를 좁혀 다시 물을 수 있다)');
  });
});

describe('변경 명령', () => {
  it('완료 기준 문장: 컬럼 추가와 옆에 두기', () => {
    const r = applyCommands(model, ['add_column mst_brand_wh.sort_no int NN =0 #정렬 순서', 'place mst_brand_wh after=mst_brand_center group=MST']);
    expect(r.model.tables[1].columns.at(-1)).toEqual({ name: 'sort_no', type: 'integer', notNull: true, default: '0', comment: '정렬 순서' });
    expect(r.places).toEqual([{ table: 'mst_brand_wh', after: 'mst_brand_center' }]);
  });
  it('설계 10-4 예시 명령과 나머지 명령', () => {
    const r = applyCommands(model, [
      'add_table mst_wh +common #창고',
      'add_column mst_wh.wh_seq integer PK',
      'rename mst_brand_wh.use_yn -> del_yn',
      'add_fk mst_brand_wh.wh_seq -> mst_wh.wh_seq',
      'alter_column mst_brand_wh.del_yn char(1) NN',
      'comment mst_brand_center #사업장별 센터',
      'comment mst_brand.brand_seq #사업장 순번',
    ]);
    const wh = r.model.tables.find(t => t.name === 'mst_wh')!;
    expect(wh.columns.map(c => c.name)).toEqual(['wh_seq', 'reg_id', 'reg_dt']);
    const bw = r.model.tables.find(t => t.name === 'mst_brand_wh')!;
    expect(bw.fks.map(f => f.name)).toEqual(['fk_bw_brand', 'fk_mst_brand_wh_mst_wh']);
    // renamedFrom: 이름을 바꾼 기록 (차이 계산이 RENAME 을 만든다)
    expect(bw.columns[2]).toEqual({ name: 'del_yn', type: 'char(1)', notNull: true, renamedFrom: 'use_yn' });
    expect(r.model.tables.find(t => t.name === 'mst_brand_center')!.comment).toBe('사업장별 센터');
    expect(r.model.tables[0].columns[0].comment).toBe('사업장 순번');
  });
  it('하나라도 실패하면 전체를 적용하지 않는다 (줄 번호와 이유)', () => {
    const before = JSON.stringify(model);
    expect(() => applyCommands(model, ['add_column mst_brand.memo text', 'add_column nope.x int'])).toThrow(/2줄 「add_column nope\.x int」: 테이블 nope 이\(가\) 없습니다/);
    expect(JSON.stringify(model)).toBe(before);
    expect(() => applyCommands(model, ['place mst_brand_wh 100 200'])).toThrow('좌표는 받지 않는다');
    expect(() => applyCommands(model, ['place mst_brand_wh after=mst_brand group=sys'])).toThrow('그룹은 mst');
    expect(() => applyCommands(model, ['explode mst_brand'])).toThrow(CommandError);
    expect(() => applyCommands(model, Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => `add_column mst_brand.c${i} int`))).toThrow('50줄까지');
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
