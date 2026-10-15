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
  connTestDraft: 'conn:testDraft',
  manualList: 'manual:list',
  manualSave: 'manual:save',
  manualRemove: 'manual:remove',
  dbReverse: 'db:reverse',
} as const;

/** 접속 정보를 어디서 가져올지: BE 폴더 properties 자동 매핑, 또는 직접 입력 */
export type ConnSource = 'be' | 'manual';

export interface Settings {
  beDir?: string;
  modelDir?: string;
  connSource?: ConnSource;
}

/** 어느 접속인지 가리키는 값 */
export type ConnRef = { source: 'be'; beDir: string; name: string } | { source: 'manual'; id: string };

/** 직접 입력한 접속 (비밀번호는 여기 담지 않는다) */
export interface ManualConn {
  id: string;
  name: string;
  driver: 'postgresql';
  host: string;
  port: number;
  database: string;
  user: string;
  readOnly: boolean;
  /** true 면 비밀번호를 Windows 계정 암호화(safeStorage)로 저장, false 면 앱을 끌 때까지만 기억 */
  savePassword: boolean;
}

export interface ManualConnInfo extends ManualConn {
  /** 지금 비밀번호를 갖고 있는지 (저장했거나 이번 실행에서 입력함) */
  hasPassword: boolean;
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
  /** 모델 폴더의 기존 화면 배치 (없으면 빈 배치). 적용할 때 이것을 써야 끌어 옮긴 위치가 지워지지 않는다 */
  layout: Layout;
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
    /** BE 폴더 properties 로 만든 프로필 */
    list(beDir: string): Promise<ProfileInfo[]>;
    test(ref: ConnRef): Promise<ConnTestResult>;
    /** 저장 전 입력값으로 접속 시험 */
    testDraft(conn: ManualConn, password: string): Promise<ConnTestResult>;
  };
  manual: {
    list(): Promise<ManualConnInfo[]>;
    /** password 를 주지 않으면 기존 비밀번호를 그대로 둔다 */
    save(conn: ManualConn, password?: string): Promise<ManualConnInfo>;
    remove(id: string): Promise<void>;
  };
  db: {
    reverse(ref: ConnRef, modelDir: string): Promise<ReverseResult>;
  };
}
