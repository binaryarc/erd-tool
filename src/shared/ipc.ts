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
  dbCatalog: 'db:catalog',
  dbRead: 'db:read',
  sqlOpen: 'sql:open',
  sqlRun: 'sql:run',
  sqlFetchMore: 'sql:fetchMore',
  sqlCommit: 'sql:commit',
  sqlRollback: 'sql:rollback',
  sqlAllowWrite: 'sql:allowWrite',
  sqlClose: 'sql:close',
  historyList: 'history:list',
  termSpawn: 'term:spawn',
  termInput: 'term:input',
  termResize: 'term:resize',
  termKill: 'term:kill',
  termData: 'term:data',
  termExit: 'term:exit',
  closeRequest: 'app:closeRequest',
  closeConfirm: 'app:closeConfirm',
  pickFile: 'dialog:pickFile',
  exportNextVersion: 'export:nextVersion',
  exportWrite: 'export:write',
  mcpInfo: 'mcp:info',
  mcpCall: 'mcp:call',
  mcpReply: 'mcp:reply',
} as const;

/** 접속 정보를 어디서 가져올지: BE 폴더 properties 자동 매핑, 또는 직접 입력 */
export type ConnSource = 'be' | 'manual';

export interface Settings {
  beDir?: string;
  modelDir?: string;
  connSource?: ConnSource;
  /** 내보내기 종류별 마지막 위치 (Flyway 폴더, MD 폴더, 이력 파일) */
  exportDirs?: { flyway?: string; md?: string; history?: string };
}

/** 내보내기로 쓸 새 파일 (폴더 없는 이름) */
export interface ExportFile { name: string; content: string }
/** 99-migration-history.md 「변경 이력」 표에 덧붙일 한 줄 */
export interface HistoryAppend { file: string; line: string }
export interface ExportResult { written: string[]; history?: string }

/** AI 연결 정보 (STEP 8). 토큰은 화면에 주지 않는다(터미널 환경변수와 Claude 연결 파일에만 있다) */
export interface McpInfo { url: string; claudeConfig: string }
/** 화면이 MCP 도구 호출에 주는 답: AI 에게 줄 글 또는 오류 */
export interface McpReply { text?: string; error?: string }

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
  /** 모델 폴더의 기존 모델 (골라 받기에서 고르지 않은 테이블은 이것을 유지) */
  prev: SchemaModel | null;
}

/** SQL 탭 세션 상태 */
export interface SqlState {
  label: string;
  /** 쿼리 이력 구분 값 */
  connKey: string;
  /** 트랜잭션이 열려 있다 */
  inTx: boolean;
  /** 커밋 안 한 변경이 있다 */
  dirty: boolean;
  readOnly: boolean;
  /** 더 가져올 행이 있다 */
  more: boolean;
}

export interface SqlResult {
  command: string;
  columns: { name: string }[];
  /** 행마다 컬럼 순서대로 값. 숫자, 참거짓 외에는 DB 가 준 글자 그대로 */
  rows: unknown[][];
  /** 결과 행 수, 또는 바뀐 행 수 */
  rowCount: number | null;
  ms: number;
  state: SqlState;
  error?: { message: string; code?: string; position?: number };
}

export interface HistoryEntry {
  /** 리터럴을 ? 로 바꾼 문장 */
  sql: string;
  count: number;
  last: string;
}

export type ShellKind = 'powershell' | 'bash';

/** SQL 자동완성용 DB 목록 (접속한 DB 에서 읽음) */
export interface SqlCatalog {
  tables: { name: string; schema: string; kind: 'table' | 'view'; comment: string; columns: { name: string; type: string; comment: string }[] }[];
  functions: { name: string; args: string; returns: string }[];
}

export interface ErdApi {
  pickFolder(defaultPath?: string): Promise<string | null>;
  /** MD 파일 고르기 (이력 파일) */
  pickFile(defaultPath?: string): Promise<string | null>;
  export: {
    /** 폴더의 V 파일 중 가장 큰 번호 + 1 */
    nextVersion(dir: string): Promise<number>;
    /** 새 파일만 쓴다. 같은 이름이 있으면 하나도 쓰지 않고 오류 */
    write(dir: string, files: ExportFile[], history?: HistoryAppend): Promise<ExportResult>;
  };
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
    /** SQL 자동완성용 테이블, 컬럼, 함수 목록 */
    catalog(ref: ConnRef): Promise<SqlCatalog>;
    /** DB 구조를 읽기만 한다 (모델 폴더와 맞추지 않음, DB 비교용) */
    read(ref: ConnRef): Promise<{ model: SchemaModel; warnings: string[] }>;
  };
  sql: {
    open(tabId: string, ref: ConnRef, label: string): Promise<SqlState>;
    run(tabId: string, sql: string): Promise<SqlResult>;
    fetchMore(tabId: string): Promise<SqlResult>;
    commit(tabId: string): Promise<SqlResult>;
    rollback(tabId: string): Promise<SqlResult>;
    allowWrite(tabId: string): Promise<SqlState>;
    close(tabId: string): Promise<void>;
  };
  history: {
    list(connKey: string): Promise<HistoryEntry[]>;
  };
  term: {
    spawn(termId: string, shell: ShellKind, cols: number, rows: number): Promise<{ shell: string; label: string; cwd: string }>;
    input(termId: string, data: string): void;
    resize(termId: string, cols: number, rows: number): void;
    kill(termId: string): void;
    onData(cb: (termId: string, data: string) => void): void;
    onExit(cb: (termId: string, code: number) => void): void;
  };
  /** 창을 닫을 때 커밋 안 한 탭이 있으면 메인이 묻는다. 화면은 확인 결과를 돌려준다 */
  onCloseRequest(cb: (dirty: { tabId: string; label: string }[]) => void): void;
  confirmClose(ok: boolean): void;
  /** AI(MCP) 연결. ERD 도구 호출은 화면이 처리해 답한다 */
  mcp: {
    /** 서버를 못 띄웠으면 null */
    info(): Promise<McpInfo | null>;
    onCall(cb: (id: number, tool: string, args: Record<string, unknown>) => void): void;
    reply(id: number, r: McpReply): void;
  };
}
