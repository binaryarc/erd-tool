// DB 종류 → 어댑터. PostgreSQL 밖의 드라이버는 그 DB 를 쓸 때만 불러온다 (앱 시작을 무겁게 하지 않게)

import { DIALECT_LABEL, type Dialect } from '../../../shared/dialect/names';
import { postgresAdapter } from './postgres';
import type { DbAdapter } from './types';

const LOADERS: Partial<Record<Dialect, () => Promise<DbAdapter>>> = {
  postgresql: async () => postgresAdapter,
  sqlserver: async () => (await import('./mssql')).mssqlAdapter,
};

export async function adapterFor(d: Dialect): Promise<DbAdapter> {
  const load = LOADERS[d];
  if (!load) throw new Error(`아직 지원하지 않는 DB: ${DIALECT_LABEL[d] ?? d}`);
  return load();
}
