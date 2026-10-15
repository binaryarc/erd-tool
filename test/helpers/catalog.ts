// 시험 보조: spikes/format/catalog.mjs 가 뽑은 catalog.json 을 스키마 모델로 바꾼다 (STEP 3 리버스의 출발점)

import type { Column, GroupRule, SchemaModel } from '../../src/shared/model/types';

interface CatalogColumn { type: string; notNull: boolean; default: string | null; comment: string }
interface Catalog {
  tables: Record<string, {
    comment: string;
    columns: Record<string, CatalogColumn>;
    pk: string[] | string;
    fks: { name: string; columns: string[] | string; refTable: string; refColumns: string[] | string }[];
  }>;
}

// PostgreSQL 이 돌려주는 긴 타입 이름을 같은 뜻의 짧은 이름으로 (정보 손실 없음)
const TYPE_ALIASES: [RegExp, string][] = [
  [/^character varying/, 'varchar'],
  [/^character\b/, 'char'],
  [/^timestamp without time zone/, 'timestamp'],
  [/^timestamp with time zone/, 'timestamptz'],
];
export const shortType = (t: string) => TYPE_ALIASES.reduce((s, [re, to]) => s.replace(re, to), t);

// 허브 spec/shop/_knowledge/patterns/20-database/40-schema/erd-groups.json 과 같은 규칙
export const SHOP_GROUPS: GroupRule[] = [
  { name: 'wms', prefix: 'whs_' },
  { name: 'mdm', prefix: 'mst_' },
  { name: 'sm', prefix: 'sm_', isDefault: true },
  { name: 'sif', prefix: 'sif_' },
  { name: 'wes', prefix: 'wes_' },
];

// pg 는 name[] 결과를 배열이 아니라 '{a,b}' 문자열로 돌려준다 (catalog.mjs 실측)
const list = (v: string[] | string): string[] =>
  Array.isArray(v) ? v : v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);

export function catalogToModel(cat: Catalog, common: Column[] = []): SchemaModel {
  const names = Object.keys(cat.tables).sort();
  return {
    version: 1,
    groups: SHOP_GROUPS,
    common,
    sequences: [],
    tables: names.map((name, i) => {
      const t = cat.tables[name];
      return {
        id: 't' + (i + 1),
        name,
        comment: t.comment,
        columns: Object.entries(t.columns).map(([cn, c]) => {
          const col: Column = { name: cn, type: shortType(c.type), notNull: c.notNull };
          if (c.default !== null) col.default = c.default;
          if (c.comment) col.comment = c.comment;
          return col;
        }),
        pk: list(t.pk),
        fks: t.fks.map(f => ({ ...f, columns: list(f.columns), refColumns: list(f.refColumns) })),
        indexes: [],
      };
    }),
  };
}
