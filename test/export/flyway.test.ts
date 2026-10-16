import { describe, expect, it } from 'vitest';
import { appendHistoryLine, buildFlyway, nextVersion, suggestDescription } from '../../src/shared/export/flyway';
import { diffModels } from '../../src/shared/model/diff';
import { addColumn, addFk, addTable } from '../../src/shared/model/edit';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const base: SchemaModel = {
  version: 1, groups: [], common: [], sequences: [], functions: [],
  tables: [table('t1', 'mst_biz', [col('biz_seq', 'integer', { notNull: true })], { pk: ['biz_seq'] })],
};
let edited = addTable(base, 'mst_probe', { comment: '시험' });
edited = addColumn(edited, 'mst_probe', { name: 'probe_seq', type: 'integer', notNull: true, pk: true });
edited = addColumn(edited, 'mst_probe', { name: 'biz_seq', type: 'integer', notNull: false });
edited = addFk(edited, 'mst_probe', { name: 'fk_probe_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] });
const now = new Date(2026, 9, 16, 9, 12);
const f = buildFlyway({ from: base, to: edited, version: 22, description: 'add_mst_probe', fromLabel: 'dev', toLabel: '지금 ERD', menuCode: 'menu01', now });

describe('Flyway 파일', () => {
  it('다음 번호는 V 파일 중 가장 큰 번호 + 1 (R__ 는 세지 않는다)', () => {
    expect(nextVersion(['V1__init.sql', 'V21__x.sql', 'V3__y.sql', 'R__resync.sql', 'notes.md'])).toBe(22);
    expect(nextVersion([])).toBe(1);
  });

  it('설명 미리 채우기', () => {
    expect(suggestDescription(diffModels(base, edited))).toBe('add_mst_probe');
    expect(suggestDescription(diffModels(base, addColumn(base, 'mst_biz', { name: 'x', type: 'text', notNull: false })))).toBe('add_mst_biz_columns');
  });

  it('이름은 V{번호}__{설명}_{시각}.sql, 설명이 snake_case 가 아니면 거부', () => {
    expect(f.fileName).toBe('V22__add_mst_probe_20261016_0912.sql');
    expect(() => buildFlyway({ from: base, to: edited, version: 1, description: 'Add-Probe', fromLabel: '', toLabel: '', now })).toThrow('snake_case');
    expect(() => buildFlyway({ from: base, to: base, version: 1, description: 'x', fromLabel: '', toLabel: '', now })).toThrow('차이가 없어');
  });

  it('허브 SD_db_flyway 정적 검사 항목을 지킨다', () => {
    const lines = f.sql.split('\n');
    expect(f.sql).not.toContain('${');
    expect(lines.filter(l => /^\\/.test(l))).toEqual([]);
    expect(lines.filter(l => /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(l))).toEqual([]);
    expect(lines.filter(l => /^\s*(DROP|DELETE|TRUNCATE)\b/i.test(l))).toEqual([]); // 추가만 한 변경이라 실행문 DROP 이 없다
    expect(lines.filter(l => l.startsWith('-- ROLLBACK'))).toHaveLength(1);
    expect(f.sql.endsWith('\n') && !f.sql.includes('\r')).toBe(true);
  });

  it('본문은 public. 과 IF NOT EXISTS, 제약 추가는 DO 블록. ROLLBACK 블록은 모두 주석', () => {
    expect(f.sql).toContain('CREATE TABLE IF NOT EXISTS public.mst_probe (');
    expect(f.sql).toContain("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.mst_probe'::regclass AND conname = 'fk_probe_biz') THEN ALTER TABLE public.mst_probe ADD CONSTRAINT fk_probe_biz FOREIGN KEY (biz_seq) REFERENCES public.mst_biz (biz_seq); END IF; END $$;");
    const rollback = f.sql.slice(f.sql.indexOf('-- ROLLBACK')).split('\n').filter(Boolean);
    expect(rollback.every(l => l.startsWith('--'))).toBe(true);
    expect(rollback).toContain('-- DROP TABLE IF EXISTS public.mst_probe;');
    expect(f.sql.split('\n')[1]).toBe('-- V22: add_mst_probe — menu01');
  });

  it('이력 한 줄과 표 끝에 넣기', () => {
    expect(f.historyLine).toBe('| 2026-10-16 09:12 | menu01 | `mst_probe` | 테이블 추가 1 — V22__add_mst_probe_20261016_0912.sql | - | - |');
    const md = '# 제목\n\n## 변경 이력\n\n| 반영일시 | a |\n|---|---|\n| 1 | x |\n\n> 메모\n';
    expect(appendHistoryLine(md, '| 2 | y |')).toBe('# 제목\n\n## 변경 이력\n\n| 반영일시 | a |\n|---|---|\n| 1 | x |\n| 2 | y |\n\n> 메모\n');
    expect(() => appendHistoryLine('# 없음\n', '| x |')).toThrow('변경 이력');
  });
});
