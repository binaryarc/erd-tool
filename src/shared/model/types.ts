// 스키마 모델 — 화면, MD, Flyway, DDL, AI 응답을 모두 이 모델에서 만든다 (설계 문서 4장)

import type { Dialect } from '../dialect/names';

/** 2: DB 종류와 스키마 줄 추가 (STEP 9). 1 은 읽을 때 PostgreSQL, public 으로 본다 */
export const MODEL_VERSION = 2;

export interface Column {
  name: string;
  type: string;
  notNull: boolean;
  default?: string;
  comment?: string;
  /** GENERATED ALWAYS(always) 또는 BY DEFAULT(default) AS IDENTITY. 시퀀스는 DB 가 따로 만든다 */
  identity?: 'always' | 'default';
  /** IDENTITY 시작값, 증가값. (1, 1) 이 아닐 때만 둔다 (SQL Server 리버스, 2026-10-16) */
  identityStart?: number;
  identityStep?: number;
  /** GENERATED ALWAYS AS (식) STORED 의 식. 있으면 default 는 없다 */
  generated?: string;
  /** 화면에서 이름을 바꾸기 전 이름. 파일에는 저장하지 않는다(메모리 전용). 차이 계산이 DROP, ADD 대신 RENAME 을 만들 때 쓴다 */
  renamedFrom?: string;
}

/** CHECK 제약. definition 은 pg_get_constraintdef 모양 그대로 (예: CHECK ((qty >= 0))) */
export interface Check {
  name: string;
  definition: string;
}

/** FK 참조 동작. NO ACTION(기본)은 적지 않는다 */
export type FkAction = 'restrict' | 'cascade' | 'set null' | 'set default';

export interface ForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: FkAction;
  onUpdate?: FkAction;
  /** DEFERRABLE (immediate: INITIALLY IMMEDIATE, deferred: INITIALLY DEFERRED). 없으면 바로 검사(NOT DEFERRABLE) */
  deferrable?: 'immediate' | 'deferred';
}

export interface Index {
  name: string;
  /** 컬럼 이름 또는 식(lower(col) 등) */
  columns: string[];
  unique: boolean;
}

/** UNIQUE 제약 (UNIQUE 인덱스와 DDL 이 달라 따로 둔다) */
export interface Unique {
  name: string;
  columns: string[];
}

/** 함수. 본문이 길어 functions/{이름}.sql 로 따로 저장한다 */
export interface FunctionDef {
  name: string;
  /** 인자 타입 (같은 이름 함수 구분) */
  args: string;
  /** CREATE OR REPLACE FUNCTION ... 전체 */
  definition: string;
}

export interface Table {
  /** 이름을 바꿔도 유지되는 내부 ID (t1, t2, ...) */
  id: string;
  name: string;
  comment: string;
  /** DB 정의 순서 */
  columns: Column[];
  /** PK 컬럼 (순서 유지). 없으면 빈 배열 */
  pk: string[];
  fks: ForeignKey[];
  uniques: Unique[];
  indexes: Index[];
  /** CHECK 제약 (없으면 생략 가능) */
  checks?: Check[];
  /** 화면에서 이름을 바꾸기 전 이름 (메모리 전용, Column.renamedFrom 과 같다) */
  renamedFrom?: string;
}

export interface GroupRule {
  name: string;
  prefix?: string;
  isDefault?: boolean;
}

export interface Sequence {
  name: string;
  start: number;
  inc: number;
}

export interface SchemaModel {
  version: number;
  /** DB 종류. 없으면 PostgreSQL (형식 버전 1 모델, 시험용 모델) */
  dialect?: Dialect;
  /** 스키마 (모델당 1개, 사용자 결정 2026-10-16). 없으면 public */
  schema?: string;
  /** 위에서부터 접두어를 대조하고, 맞는 것이 없으면 isDefault 그룹 */
  groups: GroupRule[];
  /** +common 으로 줄여 쓰는 공통 컬럼 정의 (순서 유지) */
  common: Column[];
  sequences: Sequence[];
  tables: Table[];
  functions: FunctionDef[];
}

export interface ModelError {
  file: string;
  line: number;
  message: string;
}
