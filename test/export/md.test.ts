import { describe, expect, it } from 'vitest';
import { buildMenuTables, buildSchemaDocs } from '../../src/shared/export/md';
import { fillTemplate } from '../../src/shared/export/template';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const model: SchemaModel = {
  version: 1, common: [], sequences: [{ name: 'mst_biz_seq', start: 1, inc: 1 }], functions: [],
  groups: [{ name: 'wms', prefix: 'whs_' }, { name: 'mdm', prefix: 'mst_' }, { name: 'sm', prefix: 'sm_', isDefault: true }],
  tables: [
    table('t2', 'mst_wh', [col('wh_seq', 'integer', { notNull: true }), col('biz_seq', 'integer')], {
      pk: ['wh_seq'], comment: '창고', fks: [{ name: 'fk_wh_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] }],
      indexes: [{ name: 'ix_wh_lower', columns: ['lower(wh_nm)'], unique: true }],
    }),
    table('t1', 'mst_biz', [col('biz_seq', 'integer', { notNull: true, default: "nextval('mst_biz_seq'::regclass)", comment: '사업장 | SEQ' }),
      col('memo', 'text', { comment: '줄\n바꿈' })], { pk: ['biz_seq'], comment: '사업장' }),
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
});

describe('스키마 MD', () => {
  const files = buildSchemaDocs(model, now);
  it('색인과 테이블 있는 그룹마다 한 파일, 이름에 시각', () => {
    expect(files.map(f => f.name)).toEqual(['00-tables-overview_20261016_0905.md', 'mdm-tables_20261016_0905.md', 'sm-tables_20261016_0905.md']);
  });
  it('그룹 문서: 테이블 목록, 컬럼 정의, FK, 인덱스. 표 칸의 | 와 줄바꿈을 지킨다', () => {
    const mdm = files[1].content;
    expect(mdm).toContain('| 1 | mst_biz | 사업장 |\n| 2 | mst_wh | 창고 |');
    expect(mdm).toContain("| 1 | biz_seq | integer | N | nextval('mst_biz_seq'::regclass) | PK | 사업장 \\| SEQ |");
    expect(mdm).toContain('| 2 | memo | text | Y |  |  | 줄 바꿈 |');
    expect(mdm).toContain('FK\n\n| No. | 이름 | 컬럼 | 참조 |\n|---|---|---|---|\n| 1 | fk_wh_biz | biz_seq | mst_biz(biz_seq) |');
    expect(mdm).toContain('| 1 | ix_wh_lower | lower(wh_nm) | UNIQUE |');
    expect(mdm).not.toContain('UNIQUE 제약'); // 없는 절은 빠진다
    expect(mdm).not.toMatch(/\{\{|\}\}/);
    expect(mdm).not.toMatch(/\n\n\n/);
  });
  it('색인: 그룹별 수와 문서 링크, 가운뎃점 없음, 같은 입력은 같은 출력', () => {
    const o = files[0].content;
    expect(o).toContain('| 1 | mdm | `mst_` | 2 | [mdm-tables_20261016_0905.md](./mdm-tables_20261016_0905.md) |');
    expect(o).toContain('테이블 3개, FK 1개, 시퀀스 1개, 함수 0개');
    for (const f of files) expect(f.content).not.toContain(String.fromCharCode(0xb7)); // 가운뎃점
    expect(buildSchemaDocs(model, now)).toEqual(files);
  });
});

describe('메뉴 물리 테이블 목록', () => {
  it('고른 순서대로, 업무개념은 코멘트(없으면 이름), 물리명은 대문자', () => {
    const f = buildMenuTables(model, 'MENU01', ['mst_wh', 'flyway_schema_history'], now);
    expect(f.name).toBe('menu01-03-물리테이블목록_20261016_0905.md');
    expect(f.content).toContain('| 1 | 창고 | `MST_WH` |  |\n| 2 | flyway_schema_history | `FLYWAY_SCHEMA_HISTORY` |  |');
    expect(() => buildMenuTables(model, 'menu01', [], now)).toThrow('테이블을 고르세요');
  });
});
