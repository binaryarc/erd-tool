// 메인과 렌더러 사이 IPC 함수 목록. 렌더러는 preload 가 연 이 함수들만 쓴다 (DB, 파일, 셸은 메인만).
// 단계별 전체 목록은 설계 문서 3장. 구현한 함수만 여기에 둔다.

import type { Layout } from './model/layout';
import type { ModelError, SchemaModel } from './model/types';

export const IPC = {
  modelPickFolder: 'model:pickFolder',
  modelLoad: 'model:load',
  modelSave: 'model:save',
} as const;

export interface LoadResult {
  model: SchemaModel;
  layout: Layout;
  /** 문법, 의미 오류. 있어도 읽은 만큼 돌려준다 */
  errors: ModelError[];
}

export interface SaveResult {
  /** 쓴 파일 이름 */
  written: string[];
  /** 내용이 같아 건너뛴 파일 이름 */
  unchanged: string[];
  /** 더 이상 테이블이 없어 지운 그룹 파일 */
  removed: string[];
}

export interface ErdApi {
  model: {
    pickFolder(): Promise<string | null>;
    load(dir: string): Promise<LoadResult>;
    save(dir: string, model: SchemaModel, layout: Layout): Promise<SaveResult>;
  };
}
