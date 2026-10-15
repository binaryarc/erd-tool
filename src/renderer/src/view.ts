// 캔버스 보기 상태 — 모든 테이블 노드가 같이 읽는다 (provide/inject)
import type { InjectionKey } from 'vue';

export type NameMode = 'physical' | 'logical' | 'both';

export interface ViewState {
  nameMode: NameMode;
  /** 사용자가 고르면 확대가 COMPACT_ZOOM 미만일 때 컬럼 행을 숨긴다.
   *  성능 대책이 아니다: STEP 3 측정에서 숨김을 켜도 빨라지지 않았고 배율이 기준을 넘나들 때 멈칫했다. */
  compactOnZoomOut: boolean;
  /** 지금 컬럼 행을 숨기고 있는지 (캔버스가 정한다) */
  compact: boolean;
}

export const COMPACT_ZOOM = 0.4;
export const VIEW_KEY: InjectionKey<ViewState> = Symbol('erd-view');
