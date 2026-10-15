// 트리 배치: FK 로 이어진 테이블 묶음마다 참조되는 테이블(부모)을 위, 참조하는 테이블(자식)을 아래에 놓는다 (dagre).
// 묶음은 큰 것부터 왼쪽에서 오른쪽으로 놓고, 줄이 너무 길어지면 다음 줄로 내린다.
// FK 가 없는 테이블은 맨 아래에 격자로 모은다. 좌표는 각 테이블 왼쪽 위.

import dagre from '@dagrejs/dagre';
import type { SchemaModel, Table } from './types';

const NODE_SEP = 40, RANK_SEP = 90, COMP_GAP = 140, MAX_ROW = 6000, LONE_COLS = 6;

export interface TreeSize { width: (t: Table) => number; height: (t: Table) => number }

/** FK 로 이어진 묶음 (모델 안 테이블끼리만, 자기 참조 제외) */
export function components(model: SchemaModel): Table[][] {
  const names = new Map(model.tables.map(t => [t.name, t]));
  const parent = new Map(model.tables.map(t => [t.name, t.name]));
  const find = (n: string): string => { while (parent.get(n) !== n) n = parent.get(n)!; return n; };
  for (const t of model.tables) for (const f of t.fks) {
    if (names.has(f.refTable) && f.refTable !== t.name) parent.set(find(t.name), find(f.refTable));
  }
  const groups = new Map<string, Table[]>();
  for (const t of model.tables) groups.set(find(t.name), [...(groups.get(find(t.name)) ?? []), t]);
  // 큰 묶음 먼저, 같으면 첫 테이블 이름순 (항상 같은 결과)
  return [...groups.values()].map(g => g.sort((a, b) => (a.name < b.name ? -1 : 1)))
    .sort((a, b) => b.length - a.length || (a[0].name < b[0].name ? -1 : 1));
}

function layoutComponent(tables: Table[], size: TreeSize) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: NODE_SEP, ranksep: RANK_SEP });
  g.setDefaultEdgeLabel(() => ({}));
  const inside = new Set(tables.map(t => t.name));
  for (const t of tables) g.setNode(t.id, { width: size.width(t), height: size.height(t) });
  const idOf = new Map(tables.map(t => [t.name, t.id]));
  for (const t of tables) for (const f of t.fks) {
    if (inside.has(f.refTable) && f.refTable !== t.name) g.setEdge(idOf.get(f.refTable)!, t.id); // 부모 → 자식
  }
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tables) {
    const n = g.node(t.id) as { x: number; y: number; width: number; height: number };
    const x = n.x - n.width / 2, y = n.y - n.height / 2; // dagre 는 가운데 좌표
    pos.set(t.id, { x, y });
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + n.width); maxY = Math.max(maxY, y + n.height);
  }
  for (const p of pos.values()) { p.x -= minX; p.y -= minY; }
  return { pos, width: maxX - minX, height: maxY - minY };
}

export function arrangeTree(model: SchemaModel, size: TreeSize): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const comps = components(model);
  const linked = comps.filter(c => c.length > 1);
  const lone = comps.filter(c => c.length === 1).map(c => c[0]);

  let x = 0, y = 0, rowHeight = 0;
  for (const c of linked) {
    const l = layoutComponent(c, size);
    if (x > 0 && x + l.width > MAX_ROW) { x = 0; y += rowHeight + COMP_GAP; rowHeight = 0; }
    for (const [id, p] of l.pos) out.set(id, { x: Math.round(x + p.x), y: Math.round(y + p.y) });
    x += l.width + COMP_GAP;
    rowHeight = Math.max(rowHeight, l.height);
  }

  // FK 없는 테이블: 맨 아래 격자 (칸 폭은 가장 넓은 테이블)
  if (lone.length) {
    y += (linked.length ? rowHeight + COMP_GAP : 0);
    const colW = Math.max(...lone.map(size.width)) + NODE_SEP;
    for (let i = 0; i < lone.length; i += LONE_COLS) {
      const row = lone.slice(i, i + LONE_COLS);
      row.forEach((t, c) => out.set(t.id, { x: c * colW, y }));
      y += Math.max(...row.map(size.height)) + NODE_SEP;
    }
  }
  return out;
}

/** 한 테이블과 FK 로 바로 이어진 테이블들 (참조하는 쪽, 참조되는 쪽 모두) */
export function neighborhood(model: SchemaModel, name: string): SchemaModel {
  const keep = new Set([name]);
  for (const t of model.tables) {
    if (t.name === name) for (const f of t.fks) keep.add(f.refTable);
    else if (t.fks.some(f => f.refTable === name)) keep.add(t.name);
  }
  // 고른 테이블끼리의 FK 만 남긴다 (바깥 테이블로 가는 선은 그리지 않는다)
  const tables = model.tables.filter(t => keep.has(t.name)).map(t => ({ ...t, fks: t.fks.filter(f => keep.has(f.refTable)) }));
  return { ...model, tables };
}
