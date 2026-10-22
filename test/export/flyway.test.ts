import { describe, expect, it } from 'vitest';
import { appendHistoryRow, buildFlyway, nextVersion, suggestDescription } from '../../src/shared/export/flyway';
import { diffModels } from '../../src/shared/model/diff';
import { addColumn, addFk, addTable } from '../../src/shared/model/edit';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const base: SchemaModel = {
  version: 1, groups: [], common: [], sequences: [], functions: [],
  tables: [table('t1', 'mst_brand', [col('brand_seq', 'integer', { notNull: true })], { pk: ['brand_seq'] })],
};
let edited = addTable(base, 'mst_probe', { comment: '시험' });
edited = addColumn(edited, 'mst_probe', { name: 'probe_seq', type: 'integer', notNull: true, pk: true });
edited = addColumn(edited, 'mst_probe', { name: 'brand_seq', type: 'integer', notNull: false });
edited = addFk(edited, 'mst_probe', { name: 'fk_probe_brand', columns: ['brand_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] });
const now = new Date(2026, 9, 16, 9, 12);
const f = buildFlyway({ from: base, to: edited, version: 22, description: 'add_mst_probe', fromLabel: 'dev', toLabel: '지금 ERD', menuCode: 'menu01', now });

describe('Flyway 파일', () => {
  it('다음 번호는 V 파일 중 가장 큰 번호 + 1 (R__ 는 세지 않는다)', () => {
    expect(nextVersion(['V1__init.sql', 'V21__x.sql', 'V3__y.sql', 'R__resync.sql', 'notes.md'])).toBe(22);
    expect(nextVersion([])).toBe(1);
  });

  it('설명 미리 채우기', () => {
    expect(suggestDescription(diffModels(base, edited))).toBe('add_mst_probe');
    expect(suggestDescription(diffModels(base, addColumn(base, 'mst_brand', { name: 'x', type: 'text', notNull: false })))).toBe('add_mst_brand_columns');
  });

  it('이름은 V{번호}__{설명}_{시각}.sql, 설명이 snake_case 가 아니면 거부', () => {
    expect(f.fileName).toBe('V22__add_mst_probe_20261016_0912.sql');
    expect(() => buildFlyway({ from: base, to: edited, version: 1, description: 'Add-Probe', fromLabel: '', toLabel: '', now })).toThrow('snake_case');
    expect(() => buildFlyway({ from: base, to: base, version: 1, description: 'x', fromLabel: '', toLabel: '', now })).toThrow('차이가 없어');
  });

  it('Flyway 파일 정적 검사 항목을 지킨다', () => {
    const lines = f.sql.split('\n');
    expect(f.sql).not.toContain('${');
    expect(lines.filter(l => /^\\/.test(l))).toEqual([]);
    expect(lines.filter(l => /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(l))).toEqual([]);
    expect(lines.filter(l => /^\s*(DROP|DELETE|TRUNCATE)\b/i.test(l))).toEqual([]); // 추가만 한 변경이라 실행문 DROP 이(가) 없습니다
    expect(lines.filter(l => l.startsWith('-- ROLLBACK'))).toHaveLength(1);
    expect(f.sql.endsWith('\n') && !f.sql.includes('\r')).toBe(true);
  });

  it('본문은 public. 과 IF NOT EXISTS, 제약 추가는 DO 블록. ROLLBACK 블록은 모두 주석', () => {
    expect(f.sql).toContain('CREATE TABLE IF NOT EXISTS public.mst_probe (');
    expect(f.sql).toContain("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.mst_probe'::regclass AND conname = 'fk_probe_brand') THEN ALTER TABLE public.mst_probe ADD CONSTRAINT fk_probe_brand FOREIGN KEY (brand_seq) REFERENCES public.mst_brand (brand_seq); END IF; END $$;");
    const rollback = f.sql.slice(f.sql.indexOf('-- ROLLBACK')).split('\n').filter(Boolean);
    expect(rollback.every(l => l.startsWith('--'))).toBe(true);
    expect(rollback).toContain('-- DROP TABLE IF EXISTS public.mst_probe;');
    expect(f.sql.split('\n')[1]).toBe('-- V22: add_mst_probe — menu01');
  });

  it('이력 한 줄의 칸과, 「변경 이력」 표 끝에 그 표의 칸 수로 넣기', () => {
    expect(f.historyCells).toEqual(['2026-10-16 09:12', 'menu01', '`mst_probe`', '테이블 추가 1 — V22__add_mst_probe_20261016_0912.sql']);
    const six = '# 제목\n\n## 변경 이력\n\n| 일시 | 메뉴 | 테이블 | 내용 | 테스트 | 운영 |\n|---|---|---|---|---|---|\n| 1 | - | t | x | - | - |\n\n> 메모\n';
    expect(appendHistoryRow(six, f.historyCells)).toBe(six.replace('| 1 | - | t | x | - | - |\n', '| 1 | - | t | x | - | - |\n| 2026-10-16 09:12 | menu01 | `mst_probe` | 테이블 추가 1 — V22__add_mst_probe_20261016_0912.sql | - | - |\n'));
    expect(() => appendHistoryRow('# 없음\n', ['x'])).toThrow('표가 없습니다');
  });

  it('「변경 이력」 제목이 없으면 마지막 표에, 칸이 적으면 넘친 값을 마지막 칸에 잇는다', () => {
    const md = '| a |\n|---|\n\n# 이력\n\n| 일시 | 내용 |\n|---|---|\n';
    expect(appendHistoryRow(md, ['d', 'm', 't', 's'])).toBe('| a |\n|---|\n\n# 이력\n\n| 일시 | 내용 |\n|---|---|\n| d | m — t — s |\n');
  });
});

describe('Flyway 버전 번호 형식 (점, 밑줄 버전)', () => {
  it('V2_1, V2.3 이 있으면 2.3 보다 큰 V3', () => {
    expect(nextVersion(['V2_1__a.sql', 'V2.3__b.sql', 'R__c.sql'])).toBe(3);
    expect(nextVersion(['V2_10__a.sql', 'V2_9__b.sql', 'V1__init.sql'])).toBe(3);
  });
  it('정수 버전만 있으면 지금처럼', () => {
    expect(nextVersion(['V1__init.sql', 'V19__x.sql', 'V25__y.sql', 'R__resync_sequences.sql', 'README.md'])).toBe(26);
  });
  it('읽을 수 없는 V 파일이 있으면 그 이름을 알리고 번호를 내지 않는다', () => {
    expect(() => nextVersion(['V1__init.sql', 'V2a__x.sql', 'V__y.sql'])).toThrow(/V2a__x\.sql, V__y\.sql/);
  });
});

describe('Flyway 스키마 (모델의 스키마를 쓴다)', () => {
  const wmsBase: SchemaModel = { ...base, dialect: 'postgresql', schema: 'whs' };
  const wmsEdited: SchemaModel = { ...edited, dialect: 'postgresql', schema: 'whs' };
  const g = buildFlyway({ from: wmsBase, to: wmsEdited, version: 3, description: 'add_mst_probe', fromLabel: 'a', toLabel: 'b', now });
  it('모든 문장이 whs. 를 쓰고 public. 이 없다', () => {
    expect(g.sql).not.toContain('public.');
    expect(g.sql).toContain('CREATE TABLE IF NOT EXISTS whs.mst_probe (');
    expect(g.sql).toContain("conrelid = 'whs.mst_probe'::regclass");
    expect(g.sql).toContain('REFERENCES whs.mst_brand (brand_seq)');
  });
  it('PK 지우기, 컬럼 이름 바꾸기의 DO 블록도 whs 기준', () => {
    const m2 = { ...wmsBase, tables: wmsBase.tables.map(t => ({ ...t, columns: t.columns.map(c => ({ ...c, name: 'brand_no', renamedFrom: c.name })), pk: [] })) };
    const h = buildFlyway({ from: wmsBase, to: m2, version: 4, description: 'alter_mst_brand', fromLabel: 'a', toLabel: 'b', now });
    expect(h.sql).not.toContain('public');
    expect(h.sql).toContain("table_schema = 'whs'");
    expect(h.sql).toContain("EXECUTE format('ALTER TABLE whs.%I DROP CONSTRAINT %I'");
  });
});
