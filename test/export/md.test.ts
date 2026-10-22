import { describe, expect, it } from 'vitest';
import { buildMenuTables, buildSchemaDocs } from '../../src/shared/export/md';
import { fillTemplate } from '../../src/shared/export/template';
import { buildCompareMd } from '../../src/shared/export/compare-md';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const model: SchemaModel = {
  version: 1, common: [], sequences: [{ name: 'mst_brand_seq', start: 1, inc: 1 }], functions: [],
  groups: [{ name: 'whs', prefix: 'whs_' }, { name: 'mst', prefix: 'mst_' }, { name: 'sys', prefix: 'sys_', isDefault: true }],
  tables: [
    table('t2', 'mst_wh', [col('wh_seq', 'integer', { notNull: true }), col('brand_seq', 'integer')], {
      pk: ['wh_seq'], comment: '창고', fks: [{ name: 'fk_wh_brand', columns: ['brand_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] }],
      indexes: [{ name: 'ix_wh_lower', columns: ['lower(wh_nm)'], unique: true }],
    }),
    table('t1', 'mst_brand', [col('brand_seq', 'integer', { notNull: true, default: "nextval('mst_brand_seq'::regclass)", comment: '사업장 | SEQ' }),
      col('memo', 'text', { comment: '줄\n바꿈' })], { pk: ['brand_seq'], comment: '사업장' }),
    table('t3', 'flyway_schema_history', [col('version', 'varchar(50)')]),
  ],
};
const now = new Date(2026, 9, 16, 9, 5);

describe('MD 템플릿', () => {
  it('값 넣기, 반복, 참거짓 블록, 바깥 값 찾기, 블록 줄 지우기', () => {
    const tpl = 'A {{x}}\n{{#items}}\n- {{name}} of {{x}}\n{{/items}}\n{{#flag}}\nON\n{{/flag}}\nEND\n';
    expect(fillTemplate(tpl, { x: 1, items: [{ name: 'a' }, { name: 'b' }], flag: false })).toBe('A 1\n- a of 1\n- b of 1\nEND\n');
    expect(() => fillTemplate('{{nope}}', {})).toThrow('nope');
  });
  it('없는 값은 템플릿 이름과 줄 번호로 알린다 (블록 안쪽 줄도)', () => {
    expect(() => fillTemplate('a\nb {{x}}\n{{nope}}\n', { x: 1 }, 'my.md')).toThrow('my.md 3째 줄: 템플릿 값 nope 이(가) 없습니다');
    const tpl = '# 머리\n{{#items}}\n- {{name}}\n- {{oops}}\n{{/items}}\n';
    expect(() => fillTemplate(tpl, { items: [{ name: 'a' }] }, 'list.md')).toThrow('list.md 4째 줄: 템플릿 값 oops');
  });
  it('넣은 값 안의 {{...}} 는 다시 바꾸지 않는다 (예전에는 반복 블록 안 코멘트의 {{x}} 로 MD 만들기가 멈췄다)', () => {
    expect(fillTemplate('{{#items}}{{a}}{{/items}}|{{b}}', { items: [{ a: '{{b}}' }], b: 'B' })).toBe('{{b}}|B');
    expect(() => fillTemplate('{{#items}}{{a}}{{/items}}', { items: [{ a: '{{x}}' }] })).not.toThrow();
  });
});

describe('사용자 템플릿 폴더', () => {
  it('내장 템플릿 결과에 특정 문서 체계 전용 머리 정보가 없다', () => {
    for (const f of buildSchemaDocs(model, now)) {
      for (const word of ['agent_usage', 'domain:', '40-schema', 'status: draft']) expect(f.content).not.toContain(word);
    }
  });
  it('같은 이름의 템플릿만 바꾸고 나머지는 내장으로 만든다', () => {
    const files = buildSchemaDocs(model, now, { 'group-tables.md': '# {{group}} ({{tableCount}})\n{{#tables}}\n- {{name}}\n{{/tables}}\n' });
    expect(files[1].content).toBe('# mst (2)\n- mst_brand\n- mst_wh\n');
    expect(files[0].content).toEqual(buildSchemaDocs(model, now)[0].content);
    expect(buildMenuTables(model, 'm1', ['mst_wh'], now, { 'menu-tables.md': '{{menuCode}}:{{#tables}}{{upperName}}{{/tables}}' }).content).toBe('m1:MST_WH');
    expect(buildCompareMd({ items: [], fromLabel: 'a', toLabel: 'b', now, templates: { 'db-compare.md': '{{fromLabel}}>{{toLabel}}' } })).toBe('a>b');
  });
  it('사용자 템플릿의 없는 값은 그 템플릿 이름과 줄로 알린다', () => {
    expect(() => buildSchemaDocs(model, now, { 'tables-overview.md': 'x\n{{tableCnt}}\n' })).toThrow('tables-overview.md 2째 줄: 템플릿 값 tableCnt');
  });
});

describe('스키마 MD', () => {
  const files = buildSchemaDocs(model, now);
  it('색인과 테이블 있는 그룹마다 한 파일, 이름에 시각을 붙이지 않는다', () => {
    expect(files.map(f => f.name)).toEqual(['00-tables-overview.md', 'mst-tables.md', 'sys-tables.md']);
  });
  it('그룹 문서: 테이블 목록, 컬럼 정의, FK, 인덱스. 표 칸의 | 와 줄바꿈을 지킨다', () => {
    const mst = files[1].content;
    expect(mst).toContain('| 1 | mst_brand | 사업장 |\n| 2 | mst_wh | 창고 |');
    expect(mst).toContain("| 1 | brand_seq | integer | N | nextval('mst_brand_seq'::regclass) | PK | 사업장 \\| SEQ |");
    expect(mst).toContain('| 2 | memo | text | Y |  |  | 줄 바꿈 |');
    expect(mst).toContain('FK\n\n| No. | 이름 | 컬럼 | 참조 |\n|---|---|---|---|\n| 1 | fk_wh_brand | brand_seq | mst_brand(brand_seq) |');
    expect(mst).toContain('| 1 | ix_wh_lower | lower(wh_nm) | UNIQUE |');
    expect(mst).not.toContain('UNIQUE 제약'); // 없는 절은 빠진다
    expect(mst).not.toMatch(/\{\{|\}\}/);
    expect(mst).not.toMatch(/\n\n\n/);
  });
  it('색인: 그룹별 수와 문서 링크, 가운뎃점 없음, 같은 입력은 같은 출력', () => {
    const o = files[0].content;
    expect(o).toContain('| 1 | mst | `mst_` | 2 | [mst-tables.md](./mst-tables.md) |');
    expect(o).toContain('테이블 3개, FK 1개, 시퀀스 1개, 함수 0개');
    for (const f of files) expect(f.content).not.toContain(String.fromCharCode(0xb7)); // 가운뎃점
    expect(buildSchemaDocs(model, now)).toEqual(files);
  });
});

describe('메뉴 물리 테이블 목록', () => {
  it('고른 순서대로, 업무개념은 코멘트(없으면 이름), 물리명은 대문자', () => {
    const f = buildMenuTables(model, 'MENU01', ['mst_wh', 'flyway_schema_history'], now);
    expect(f.name).toBe('menu01-03-물리테이블목록.md');
    expect(f.content).toContain('| 1 | 창고 | `MST_WH` |  |\n| 2 | flyway_schema_history | `FLYWAY_SCHEMA_HISTORY` |  |');
    expect(() => buildMenuTables(model, 'menu01', [], now)).toThrow('테이블을 고르세요');
  });
});
