// layout.json — 화면 배치. 위치는 그룹 규칙 + 순서로 계산하고, 사람이 끌어 옮긴 테이블만 좌표를 둔다 (설계 문서 4장, 10-3)

export const LAYOUT_FILE = 'layout.json';
export const LAYOUT_VERSION = 1;

export interface GroupPlacement {
  rule: { cols: number; gap: number; origin: [number, number] };
  /** 테이블 ID 순서. 격자에 이 순서대로 놓는다 */
  order: string[];
}

export interface Diagram {
  /** 배치 방식: grid 는 그룹별 격자, tree 는 FK 트리 (없으면 tree, arrangeMode 로 읽는다) */
  mode?: 'grid' | 'tree';
  /** 그룹 격자 배치(접두어 그룹별 열 수, 간격, 순서). 「그룹 격자」 정렬일 때만 둔다 (2026-10-16 사용자 지정: 트리에서는 저장하지 않는다) */
  groups?: Record<string, GroupPlacement>;
  /** 테이블 ID → 직접 지정한 좌표 */
  pinned: Record<string, [number, number]>;
  /** 그룹 탭(STEP 10)의 소속 테이블 ID. 있으면 이 다이어그램은 그 테이블만 보인다. 「전체」 에는 없다 */
  members?: string[];
  /** 마지막으로 본 화면 위치와 확대 배율. 열 때 전체 보기 대신 이 자리로 연다 (2026-10-16 사용자 요청) */
  viewport?: { x: number; y: number; zoom: number };
}

export interface Layout {
  version: number;
  diagrams: Record<string, Diagram>;
  /** 그룹 탭 이름을 화면 순서대로 (STEP 10). 「전체」 는 넣지 않는다. 없으면 그룹 탭 없음 */
  tabs?: string[];
}

/** 배치 방식을 읽는다. 적혀 있지 않으면 트리 (사용자 지정 2026-10-16. 처음에는 그룹 격자였다) */
export const arrangeMode = (d: Pick<Diagram, 'mode'>): 'grid' | 'tree' => d.mode ?? 'tree';

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
