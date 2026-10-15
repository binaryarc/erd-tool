// 접속 정보 찾기와 연결 — 리버스, 접속 시험, SQL 탭이 같이 쓴다. 비밀번호는 메인 프로세스 안에서만 다룬다.

import path from 'node:path';
import pg from 'pg';
import type { ConnRef } from '../../shared/ipc';
import { getProfile, passwordOf } from './profiles';

export interface Target { host: string; port: number; database: string; user: string; password: string; readOnly: boolean }

/** 접속 정보를 BE properties 또는 직접 입력 목록에서 찾는다 */
export async function resolve(ref: ConnRef): Promise<Target> {
  if (ref.source === 'be') {
    const p = getProfile(ref.beDir, ref.name);
    return { host: p.host, port: p.port, database: p.database, user: p.user, password: passwordOf(p, ref.beDir), readOnly: p.readOnly };
  }
  // electron 모듈을 쓰므로 직접 입력일 때만 불러온다 (BE 통합 시험은 Electron 밖에서 돈다)
  const { resolveManual } = await import('./manual');
  const { conn, password } = await resolveManual(ref.id);
  return { ...conn, password };
}

/** readOnly 면 이 연결의 모든 트랜잭션을 DB 서버가 읽기 전용으로 막는다 */
export async function connect(t: Target, readOnly: boolean): Promise<pg.Client> {
  const client = new pg.Client({
    host: t.host, port: t.port, database: t.database, user: t.user, password: t.password,
    connectionTimeoutMillis: 10_000, application_name: 'erd-tool',
  });
  await client.connect();
  if (readOnly) await client.query('set default_transaction_read_only = on');
  return client;
}

/** 쿼리 이력 파일 이름 등에 쓰는 접속 구분 값 */
export const connKey = (ref: ConnRef) =>
  ref.source === 'be' ? `be-${path.basename(ref.beDir)}-${ref.name}` : `manual-${ref.id}`;
