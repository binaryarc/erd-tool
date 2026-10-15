// 스키마 모델 — 화면, MD, Flyway, DDL, AI 응답을 모두 이 모델에서 만든다 (설계 문서 4장)

export const MODEL_VERSION = 1;

export interface Column {
  name: string;
  type: string;
  notNull: boolean;
  default?: string;
  comment?: string;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
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
