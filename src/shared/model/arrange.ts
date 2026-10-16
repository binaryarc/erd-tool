// layout.json 의 그룹 규칙(열 수, 간격, 시작점)과 순서로 테이블 좌표를 계산한다 (설계 4장, 10-3)
// 좌표는 저장하지 않는다. 사람이 끌어 옮긴 테이블만 pinned 에 좌표가 있다.

import { groupOf } from './erd-format';
import type { Diagram, Layout } from './layout';
import type { SchemaModel, Table } from './types';

/** 화면 크기 (TableNode.vue 의 CSS 와 같아야 한다). width 는 최소 폭, 실제 폭은 내용에 맞춘다 */
export const NODE = { width: 220, maxWidth: 560, headHeight: 24, rowHeight: 18, compactHeight: 24 } as const;
export const DEFAULT_RULE = { cols: 4, gap: 40 } as const;
const GROUP_GAP = 160;
const GROUP_TITLE = 36;

export const DEFAULT_DIAGRAM = '전체';

export const tableHeight = (t: Table, compact = false) =>
  compact ? NODE.compactHeight : NODE.headHeight + t.columns.length * NODE.rowHeight + 2;

export interface GroupBox { name: string; x: number; y: number; width: number; height: number }

export interface Arranged {
  positions: Map<string, { x: number; y: number }>;
  groups: GroupBox[];
}

/**
 * 다이어그램이 없으면 만들고, 그룹마다 순서를 모델에 맞춘다(없어진 ID 는 빼고 새 테이블은 이름순으로 뒤에 붙임).
 * 처음 만드는 그룹은 앞 그룹 오른쪽에 놓는다. layout 을 직접 고친다.
 */
export function syncLayout(model: SchemaModel, layout: Layout, diagram = DEFAULT_DIAGRAM): Diagram {
  const d = (layout.diagrams[diagram] ??= { groups: {}, pinned: {} });
  const byGroup = new Map<string, Table[]>();
  for (const t of [...model.tables].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const g = groupOf(t.name, model.groups);
    byGroup.set(g, [...(byGroup.get(g) ?? []), t]);
  }
  const ids = new Set(model.tables.map(t => t.id));
  for (const g of Object.keys(d.groups)) if (!byGroup.has(g)) delete d.groups[g];
  for (const id of Object.keys(d.pinned)) if (!ids.has(id)) delete d.pinned[id];

  // 그룹 규칙 순서대로, 새 그룹은 지금 있는 그룹들의 오른쪽 끝에 붙인다
  let right = Math.max(0, ...Object.values(d.groups).map(g => g.rule.origin[0] + groupWidth(g.rule) + GROUP_GAP));
  for (const rule of model.groups) {
    const tables = byGroup.get(rule.name);
    if (!tables) continue;
    let g = d.groups[rule.name];
    if (!g) {
      g = d.groups[rule.name] = { rule: { cols: DEFAULT_RULE.cols, gap: DEFAULT_RULE.gap, origin: [right, 0] }, order: [] };
      right += groupWidth(g.rule) + GROUP_GAP;
    }
    const inGroup = new Set(tables.map(t => t.id));
    g.order = g.order.filter(id => inGroup.has(id));
    const placed = new Set(g.order);
    for (const t of tables) if (!placed.has(t.id)) g.order.push(t.id);
  }
  return d;
}

const groupWidth = (rule: { cols: number; gap: number }, colWidth: number = NODE.width) => rule.cols * colWidth + (rule.cols - 1) * rule.gap;

/**
 * 격자 배치: 순서대로 왼쪽에서 오른쪽, 줄 높이는 그 줄에서 가장 높은 테이블.
 * widthOf 를 주면 테이블마다 폭이 다를 수 있다. 그룹 안 칸 폭은 그 그룹에서 가장 넓은 테이블에 맞춰 격자를 지킨다.
 * 폭이 늘어 그룹이 겹치면 뒤 그룹을 오른쪽으로 민다 (저장된 시작점은 바꾸지 않는다).
 */
export function arrange(model: SchemaModel, d: Diagram, widthOf: (t: Table) => number = () => NODE.width): Arranged {
  const byId = new Map(model.tables.map(t => [t.id, t]));
  const positions = new Map<string, { x: number; y: number }>();
  const groups: GroupBox[] = [];
  let prevRight = -Infinity;
  const entries = Object.entries(d.groups).sort(([, a], [, b]) => a.rule.origin[0] - b.rule.origin[0]);
  for (const [name, g] of entries) {
    const { cols, gap, origin } = g.rule;
    const tables = g.order.map(id => byId.get(id)).filter((t): t is Table => !!t);
    const colWidth = Math.max(NODE.width, ...tables.map(widthOf));
    const x0 = Math.max(origin[0], prevRight + GROUP_GAP);
    let y = origin[1] + GROUP_TITLE;
    for (let i = 0; i < tables.length; i += cols) {
      const row = tables.slice(i, i + cols);
      row.forEach((t, c) => positions.set(t.id, { x: x0 + c * (colWidth + gap), y }));
      // 끌어 옮긴(고정한) 테이블은 그 칸에 없으므로 줄 높이에 넣지 않는다. 고정한 테이블이 커져도 다른 테이블이 움직이지 않게 (STEP 8)
      y += Math.max(0, ...row.filter(t => !d.pinned[t.id]).map(t => tableHeight(t))) + gap;
    }
    const width = groupWidth(g.rule, colWidth) + 40;
    groups.push({ name, x: x0 - 20, y: origin[1], width, height: y - origin[1] });
    prevRight = x0 - 20 + width;
  }
  for (const [id, [x, y]] of Object.entries(d.pinned)) if (byId.has(id)) positions.set(id, { x, y });
  return { positions, groups };
}
