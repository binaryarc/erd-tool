// layout.json — 화면 배치. 위치는 그룹 규칙 + 순서로 계산하고, 사람이 끌어 옮긴 테이블만 좌표를 둔다 (설계 문서 4장, 10-3)

export const LAYOUT_FILE = 'layout.json';
export const LAYOUT_VERSION = 1;

export interface GroupPlacement {
  rule: { cols: number; gap: number; origin: [number, number] };
  /** 테이블 ID 순서. 격자에 이 순서대로 놓는다 */
  order: string[];
}

export interface Diagram {
  /** 배치 방식: grid 는 그룹별 격자, tree 는 FK 트리 (없으면 grid) */
  mode?: 'grid' | 'tree';
  groups: Record<string, GroupPlacement>;
  /** 테이블 ID → 직접 지정한 좌표 */
  pinned: Record<string, [number, number]>;
}

export interface Layout {
  version: number;
  diagrams: Record<string, Diagram>;
}

export const emptyLayout = (): Layout => ({ version: LAYOUT_VERSION, diagrams: {} });

/** 객체 키를 정렬해 저장한다. 배열 순서(order, 좌표)는 의미가 있어 그대로 둔다 */
export function serializeLayout(layout: Layout): string {
  return JSON.stringify(sortKeys(layout), null, 2) + '\n';
}

export function parseLayout(text: string): Layout {
  const v = JSON.parse(text) as Layout;
  if (v.version !== LAYOUT_VERSION) throw new Error(`지원하지 않는 layout 버전: ${v.version}`);
  return v;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
