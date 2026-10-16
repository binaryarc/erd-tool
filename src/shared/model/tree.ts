// 트리 배치: FK 로 이어진 테이블 묶음마다 참조되는 테이블(부모)을 위, 참조하는 테이블(자식)을 아래에 놓는다 (dagre).
// 묶음은 큰 것부터 왼쪽에서 오른쪽으로 놓고, 줄이 너무 길어지면 다음 줄로 내린다.
// FK 가 없는 테이블은 맨 아래에 칸을 나눠 쌓는다. 전체가 화면 비율에 가까운 사각형이 되게 줄 폭을 정한다. 좌표는 각 테이블 왼쪽 위.

import dagre from '@dagrejs/dagre';
import type { SchemaModel, Table } from './types';

// 간격 (2026-10-16 사용자 요청으로 좁힘. 전: 테이블 사이 40, 부모와 자식 사이 90, 묶음 사이 140, 한 줄 최대 6000, 외톨이 6열)
const NODE_SEP = 24, RANK_SEP = 56, COMP_GAP = 64;
/** 배치 전체의 가로세로 비 목표 (넓은 모니터) */
const ASPECT = 1.6;

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

type Placed = { pos: Map<string, { x: number; y: number }>; width: number; height: number };
type Comp = ReturnType<typeof layoutComponent>;

/**
 * 묶음들을 줄 폭(rowWidth) 안에서 왼쪽에서 오른쪽, 줄을 넘으면 다음 줄로 놓고,
 * FK 없는 테이블은 그 아래를 칸으로 나눠 키 큰 것부터 가장 짧은 칸에 쌓는다 (빈 곳이 덜 생긴다)
 */
function pack(linked: Comp[], lone: Table[], rowWidth: number, colW: number, size: TreeSize): Placed {
  const pos = new Map<string, { x: number; y: number }>();
  let x = 0, y = 0, rowHeight = 0, width = 0;
  for (const l of linked) {
    if (x > 0 && x + l.width > rowWidth) { x = 0; y += rowHeight + COMP_GAP; rowHeight = 0; }
    for (const [id, p] of l.pos) pos.set(id, { x: Math.round(x + p.x), y: Math.round(y + p.y) });
    width = Math.max(width, x + l.width);
    x += l.width + COMP_GAP;
    rowHeight = Math.max(rowHeight, l.height);
  }
  let height = linked.length ? y + rowHeight : 0;
  if (lone.length) {
    const top = linked.length ? height + COMP_GAP : 0;
    const cols = Array.from({ length: Math.max(1, Math.floor((rowWidth + NODE_SEP) / colW)) }, () => top);
    for (const t of [...lone].sort((a, b) => size.height(b) - size.height(a) || (a.name < b.name ? -1 : 1))) {
      const c = cols.indexOf(Math.min(...cols));
      pos.set(t.id, { x: c * colW, y: Math.round(cols[c]) });
      cols[c] += size.height(t) + NODE_SEP;
      width = Math.max(width, c * colW + size.width(t));
    }
    height = Math.max(height, Math.max(...cols) - NODE_SEP);
  }
  return { pos, width, height };
}

/** 넓은 화면(16:10)에 전체를 넣을 때의 배율. 클수록 한눈에 크게 보인다 */
const fitScore = (p: Placed) => Math.min(1600 / Math.max(p.width, 1), 1000 / Math.max(p.height, 1));

export function arrangeTree(model: SchemaModel, size: TreeSize): Map<string, { x: number; y: number }> {
  const comps = components(model);
  const linked = comps.filter(c => c.length > 1).map(c => layoutComponent(c, size));
  const lone = comps.filter(c => c.length === 1).map(c => c[0]);
  const colW = lone.length ? Math.max(...lone.map(size.width)) + NODE_SEP : 0;
  const areaOf = (ls: Comp[], ts: Table[]) => ls.reduce((a, l) => a + (l.width + COMP_GAP) * (l.height + COMP_GAP), 0)
    + ts.reduce((a, t) => a + colW * (size.height(t) + NODE_SEP), 0);

  // 배치 A: 줄 폭을 전체 넓이가 화면 비율(ASPECT) 사각형이 되게 정하고 위에서 아래로 (2026-10-16 사용자 요청: 한눈에 많이)
  const a = pack(linked, lone, Math.max(colW, ...linked.map(l => l.width), Math.sqrt(areaOf(linked, lone) * ASPECT)), colW, size);
  // 배치 B: 가장 큰 묶음이 아주 길면(shop 는 41개 묶음이 다른 것을 다 합친 것보다 길다) 그 묶음을 왼쪽에 두고
  // 나머지를 그 오른쪽에 그 높이 안에 들어가게 쌓는다
  let best = a;
  if (linked.length) {
    const [big, ...rest] = linked;
    const restW = Math.max(colW, ...rest.map(l => l.width), areaOf(rest, lone) / Math.max(big.height, 1) * 1.15);
    const right = pack(rest, lone, restW, colW, size);
    const ox = big.width + COMP_GAP;
    const pos = new Map<string, { x: number; y: number }>();
    for (const [id, p] of big.pos) pos.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
    for (const [id, p] of right.pos) pos.set(id, { x: p.x + Math.round(ox), y: p.y });
    const b: Placed = { pos, width: right.pos.size ? ox + right.width : big.width, height: Math.max(big.height, right.height) };
    if (fitScore(b) > fitScore(a)) best = b;
  }
  return best.pos;
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
