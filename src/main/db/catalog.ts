// SQL 자동완성용 목록: 접속한 DB 의 테이블, 뷰, 컬럼, 함수 이름 (DBeaver 처럼 ERD 를 열지 않아도 쓰게)
// 읽기 전용 연결을 따로 잠깐 열어 읽는다. SQL 탭 연결(트랜잭션 중일 수 있음)은 건드리지 않는다.

import type { ConnRef, SqlCatalog } from '../../shared/ipc';
import { connectRef } from './connect';

export async function loadCatalog(ref: ConnRef): Promise<SqlCatalog> {
  const { conn, adapter } = await connectRef(ref, true);
  try {
    return await adapter.catalog(conn);
  } finally {
    await conn.close();
  }
}
