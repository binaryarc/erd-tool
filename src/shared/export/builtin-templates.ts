// 내장 MD 템플릿과 사용자 템플릿 고르기 (2026-10-22).
// 설정의 템플릿 폴더(mdTemplateDir)에 같은 이름의 파일이 있으면 그 파일을, 없으면 설치 파일 안의 내장 템플릿을 쓴다.

import groupTables from './templates/group-tables.md?raw';
import tablesOverview from './templates/tables-overview.md?raw';
import tableList from './templates/table-list.md?raw';
import dbCompare from './templates/db-compare.md?raw';

export const BUILTIN_TEMPLATES = {
  'group-tables.md': groupTables,
  'tables-overview.md': tablesOverview,
  'table-list.md': tableList,
  'db-compare.md': dbCompare,
};

export type TemplateName = keyof typeof BUILTIN_TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(BUILTIN_TEMPLATES) as TemplateName[];

/** 템플릿 폴더에서 읽은 파일 (이름 → 내용). 없는 이름은 내장을 쓴다 */
export type TemplateSet = Partial<Record<TemplateName, string>>;

export const templateOf = (set: TemplateSet | undefined, name: TemplateName) => set?.[name] ?? BUILTIN_TEMPLATES[name];
