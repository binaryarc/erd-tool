// 메인과 렌더러 사이 IPC 함수 목록. 렌더러는 preload 가 연 이 함수들만 쓴다 (DB, 파일, 셸은 메인만).
// 단계별 전체 목록은 설계 문서 3-1. 구현한 함수만 여기에 둔다.

import type { Layout } from './model/layout';
import type { ModelDiff } from './model/merge';
import type { ModelError, SchemaModel } from './model/types';

export const IPC = {
  pickFolder: 'dialog:pickFolder',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  modelLoad: 'model:load',
  modelSave: 'model:save',
  connList: 'conn:list',
  connTest: 'conn:test',
  dbReverse: 'db:reverse',
} as const;

export interface Settings {
  beDir?: string;
  modelDir?: string;
}

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
  /** 더 이상 테이블, 함수가 없어 지운 파일 */
  removed: string[];
}

/** 접속 프로필 (비밀번호 없음) */
export interface ProfileInfo {
  name: string;
  driver: string;
  host: string;
  port: number;
  database: string;
  user: string;
  readOnly: boolean;
}

export interface ConnTestResult {
  ok: boolean;
  message: string;
  tables?: number;
  fks?: number;
  server?: string;
}

export interface ReverseResult {
  model: SchemaModel;
  diff: ModelDiff;
  warnings: string[];
  /** DB 를 직접 센 테이블 수, FK 수 */
  counts: { tables: number; fks: number };
  /** 모델 폴더에 기존 모델이 있었는지 */
  hadModel: boolean;
}

export interface ErdApi {
  pickFolder(defaultPath?: string): Promise<string | null>;
  settings: {
    get(): Promise<Settings>;
    set(patch: Settings): Promise<Settings>;
  };
  model: {
    load(dir: string): Promise<LoadResult>;
    save(dir: string, model: SchemaModel, layout: Layout): Promise<SaveResult>;
  };
  conn: {
    list(beDir: string): Promise<ProfileInfo[]>;
    test(beDir: string, profile: string): Promise<ConnTestResult>;
  };
  db: {
    reverse(beDir: string, profile: string, modelDir: string): Promise<ReverseResult>;
  };
}
