// 캔버스 보기 상태 — 모든 테이블 노드가 같이 읽는다 (provide/inject)
import type { InjectionKey } from 'vue';

export type NameMode = 'physical' | 'logical' | 'both';
/** Vue Flow 선 종류: 꺾은선, 직선, 곡선 */
export type EdgeKind = 'smoothstep' | 'straight' | 'default';

export interface ViewState {
  nameMode: NameMode;
  edgeKind: EdgeKind;
  /** 사용자가 고르면 확대가 COMPACT_ZOOM 미만일 때 컬럼 행을 숨긴다.
   *  성능 대책이 아니다: STEP 3 측정에서 숨김을 켜도 빨라지지 않았고 배율이 기준을 넘나들 때 멈칫했다. */
  compactOnZoomOut: boolean;
  /** 지금 컬럼 행을 숨기고 있는지 (캔버스가 정한다) */
  compact: boolean;
  /** 고른 컬럼 (`테이블\t컬럼`). 복사, 붙여넣기용 (2026-10-16 사용자 요청) */
  colSel: string[];
  /** 컬럼 행을 눌렀을 때. add 면 고른 것에 더하거나 뺀다 (Shift, Ctrl) */
  onColumnClick?: (table: string, column: string, add: boolean) => void;
}

export const colKey = (table: string, column: string) => `${table}\t${column}`;

export const COMPACT_ZOOM = 0.4;
export const VIEW_KEY: InjectionKey<ViewState> = Symbol('erd-view');

/** 이 PC 에 기억하는 보기 설정 (못 쓰면 기억만 안 함) */
export function loadPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem('view:' + key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
}
export function savePref(key: string, value: string) {
  try { localStorage.setItem('view:' + key, value); } catch { /* 기억 못 함 */ }
}
