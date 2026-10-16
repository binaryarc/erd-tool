// DB 종류 이름 (다른 모듈을 불러오지 않는다: 모델 형식, 타입 정의가 고리 없이 쓰게)

import type { SchemaModel } from '../model/types';

export type Dialect = 'postgresql' | 'sqlserver' | 'mysql' | 'oracle';

export const DIALECT_LABEL: Record<Dialect, string> = { postgresql: 'PostgreSQL', sqlserver: 'SQL Server', mysql: 'MySQL', oracle: 'Oracle' };
export const DIALECTS = Object.keys(DIALECT_LABEL) as Dialect[];

/** 모델의 DB 종류 (형식 버전 1 모델과 시험용 모델은 값이 없어 PostgreSQL) */
export const dialectOf = (m: Pick<SchemaModel, 'dialect'> | null | undefined): Dialect => m?.dialect ?? 'postgresql';
export const schemaOf = (m: Pick<SchemaModel, 'schema'> | null | undefined): string => m?.schema ?? 'public';
