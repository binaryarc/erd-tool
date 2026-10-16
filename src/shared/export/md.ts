// 스키마 모델 → MD 문서 (STEP 7, 설계 8-1). 형식은 templates/*.md 에 있고 여기서는 값만 만든다.
// 그룹 문서(그룹마다 하나), 색인, 메뉴 물리 테이블 목록 조각. 파일 이름에 시각을 붙이지 않고 같은 이름은 덮어쓴다(사용자 지정 2026-10-16).
// 만든 시각은 문서 안 generated_at 에 남는다.

import groupTpl from './templates/group-tables.md?raw';
import overviewTpl from './templates/tables-overview.md?raw';
import menuTpl from './templates/menu-tables.md?raw';
import { cell, fillTemplate } from './template';
import { groupOf } from '../model/erd-format';
import type { SchemaModel, Table } from '../model/types';

export interface MdFile { name: string; content: string }

const pad = (n: number) => String(n).padStart(2, '0');
const generatedAt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const byName = (a: Table, b: Table) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
/** 반복 항목에 순번과 처음, 끝 표시를 붙인다 (템플릿의 {{no}}, {{#first}}, {{#last}}) */
const numbered = <T extends object>(xs: T[]) => xs.map((x, i) => ({ ...x, no: i + 1, first: i === 0, last: i === xs.length - 1 }));

function tableValues(t: Table) {
  return {
    name: t.name, comment: cell(t.comment),
    columns: numbered(t.columns.map(c => ({
      name: c.name, type: cell(c.type), nullable: c.notNull ? 'N' : 'Y', default: cell(c.default), pk: t.pk.includes(c.name) ? 'PK' : '', comment: cell(c.comment),
    }))),
    fks: numbered(t.fks.map(f => ({ name: f.name, columns: f.columns.join(', '), ref: `${f.refTable}(${f.refColumns.join(', ')})` }))),
    uniques: numbered(t.uniques.map(u => ({ name: u.name, columns: u.columns.join(', ') }))),
    indexes: numbered(t.indexes.map(i => ({ name: i.name, columns: cell(i.columns.join(', ')), unique: i.unique ? 'UNIQUE' : '' }))),
  };
}

/** 그룹별 테이블 (그룹 규칙 순서, 테이블 없는 그룹은 뺀다) */
function grouped(model: SchemaModel) {
  return model.groups
    .map(g => ({ rule: g, tables: model.tables.filter(t => groupOf(t.name, model.groups) === g.name).sort(byName) }))
    .filter(g => g.tables.length);
}

/** 그룹 문서들과 색인. 이름: {그룹}-tables.md, 00-tables-overview.md */
export function buildSchemaDocs(model: SchemaModel, now: Date): MdFile[] {
  const at = generatedAt(now);
  const groups = grouped(model);
  const files = groups.map(({ rule, tables }) => ({
    name: `${rule.name}-tables.md`,
    content: fillTemplate(groupTpl, {
      group: rule.name, generatedAt: at, tableCount: tables.length,
      columnCount: tables.reduce((n, t) => n + t.columns.length, 0), fkCount: tables.reduce((n, t) => n + t.fks.length, 0),
      tables: numbered(tables.map(tableValues)),
    }),
  }));
  const overview = fillTemplate(overviewTpl, {
    generatedAt: at, tableCount: model.tables.length, fkCount: model.tables.reduce((n, t) => n + t.fks.length, 0),
    seqCount: model.sequences.length, fnCount: model.functions.length,
    groups: numbered(groups.map(({ rule, tables }, i) => ({
      name: rule.name, prefix: rule.prefix ? `\`${rule.prefix}\`` : '(기본 그룹)', count: tables.length, file: files[i].name,
      tables: numbered(tables.map(t => ({ name: t.name, comment: cell(t.comment) }))),
    }))),
  });
  return [{ name: '00-tables-overview.md', content: overview }, ...files];
}

/** 메뉴 설계 문서 「물리 테이블 목록」 절에 붙여 넣을 조각. 업무개념은 테이블 코멘트, 비고는 사람이 채운다 */
export function buildMenuTables(model: SchemaModel, menuCode: string, tableNames: string[], now: Date): MdFile {
  if (!/^[a-z0-9_]+$/i.test(menuCode)) throw new Error('메뉴코드는 영문, 숫자로 입력하세요');
  if (!tableNames.length) throw new Error('ERD 에서 테이블을 고르세요 (Ctrl+클릭으로 여러 개)');
  const tables = tableNames.map(n => model.tables.find(t => t.name === n) ?? (() => { throw new Error(`테이블 ${n} 이 없다`); })());
  const code = menuCode.toLowerCase();
  return {
    name: `${code}-03-물리테이블목록.md`,
    content: fillTemplate(menuTpl, {
      menuCode: code, generatedAt: generatedAt(now),
      tables: numbered(tables.map(t => ({ concept: cell(t.comment) || t.name, upperName: t.name.toUpperCase() }))),
    }),
  };
}
