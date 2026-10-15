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
}

export interface ModelError {
  file: string;
  line: number;
  message: string;
}
