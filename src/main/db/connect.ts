// 접속 정보 찾기와 연결 — 리버스, 접속 시험, SQL 탭이 같이 쓴다. 비밀번호는 메인 프로세스 안에서만 다룬다.
// 연결은 DB 종류별 어댑터(adapters/)가 연다.

import path from 'node:path';
import type { ConnRef } from '../../shared/ipc';
import { adapterFor } from './adapters';
import type { DbAdapter, DbConn, Target } from './adapters/types';
import { getProfile, passwordOf } from './profiles';
import { markWrong, passwordFor } from './passwords';

export type { Target } from './adapters/types';

/** BE 프로필 비밀번호를 기억하는 이름 (BE 폴더와 프로필) */
export const profileKey = (beDir: string, name: string) => `be:${path.resolve(beDir).toLowerCase()}:${name}`;

/** 접속 정보를 BE properties 또는 직접 입력 목록에서 찾는다.
 *  BE 프로필 비밀번호는 입력해 기억한 값 → properties 자동(평문, ENC 복호화) → 화면에 묻기 순서 (passwords.ts) */
export async function resolve(ref: ConnRef): Promise<Target> {
  if (ref.source === 'be') {
    const p = getProfile(ref.beDir, ref.name);
    const password = await passwordFor(profileKey(ref.beDir, ref.name), `${p.name} (${p.database})`, () => passwordOf(p, ref.beDir));
    return { dialect: p.dialect!, host: p.host, port: p.port, database: p.database, user: p.user, password, readOnly: p.readOnly };
  }
  // electron 모듈을 쓰므로 직접 입력일 때만 불러온다 (BE 통합 시험은 Electron 밖에서 돈다)
  const { resolveManual } = await import('./manual');
  const { conn, password } = await resolveManual(ref.id);
  const { driver, ...rest } = conn;
  return { ...rest, dialect: driver, password };
}

/** readOnly 면 이 연결의 트랜잭션을 읽기 전용으로 연다 (서버가 막는 DB 만. 나머지는 DB 계정 권한으로 막는다) */
export async function connect(t: Target, readOnly: boolean): Promise<DbConn> {
  return (await adapterFor(t.dialect)).connect(t, readOnly);
}

/** 접속을 찾아 연결한다. BE 프로필 비밀번호가 틀려 DB 가 거부하면 기억한 값을 지우고 다시 물어 한 번 더 붙는다.
 *  readOnly 를 주지 않으면 접속 설정(운영은 읽기 전용)을 따른다 */
export async function connectRef(ref: ConnRef, readOnly?: boolean, resolver: (r: ConnRef) => Promise<Target> = resolve): Promise<{ conn: DbConn; adapter: DbAdapter; target: Target }> {
  for (let attempt = 0; ; attempt++) {
    const target = await resolver(ref);
    const adapter = await adapterFor(target.dialect);
    try {
      return { conn: await adapter.connect(target, readOnly ?? target.readOnly), adapter, target };
    } catch (e) {
      if (ref.source !== 'be' || !adapter.isAuthError(e) || attempt >= 3) throw e;
      await markWrong(profileKey(ref.beDir, ref.name));
    }
  }
}

/** 쿼리 이력 파일 이름 등에 쓰는 접속 구분 값 */
export const connKey = (ref: ConnRef) =>
  ref.source === 'be' ? `be-${path.basename(ref.beDir)}-${ref.name}` : `manual-${ref.id}`;
