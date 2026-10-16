// 직접 입력한 접속 목록. 접속 정보는 앱 설정 폴더 connections.json, 비밀번호는 따로 둔다.
// - 저장을 고르면 safeStorage(Windows 계정 암호화)로 암호화해 secrets.json 에 둔다
// - 고르지 않으면 이 실행의 메모리에만 둔다
// 평문 비밀번호는 파일, 로그, 화면 어디에도 남기지 않는다 (설계 12장).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, safeStorage } from 'electron';
import type { ManualConn, ManualConnInfo } from '../../shared/ipc';
import type { SecretStore } from './passwords';

const file = (name: string) => path.join(app.getPath('userData'), name);
const memory = new Map<string, string>();

function readJson<T>(name: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T; } catch { return fallback; }
}
function writeJson(name: string, value: unknown) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const conns = () => readJson<ManualConn[]>('connections.json', []);
/** id → 암호화한 비밀번호(base64) */
const secrets = () => readJson<Record<string, string>>('secrets.json', {});

const info = (c: ManualConn): ManualConnInfo => ({ ...c, hasPassword: memory.has(c.id) || c.id in secrets() });

export const listManual = (): ManualConnInfo[] => conns().map(info);

export async function saveManual(conn: ManualConn, password?: string): Promise<ManualConnInfo> {
  const c: ManualConn = { ...conn, id: conn.id || crypto.randomUUID() };
  writeJson('connections.json', [...conns().filter(x => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name)));

  const s = secrets();
  if (password !== undefined) memory.set(c.id, password);
  const pw = memory.get(c.id);
  if (c.savePassword && pw !== undefined) {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('이 PC 에서는 비밀번호 암호화를 쓸 수 없습니다. 저장하지 않고 쓰세요');
    s[c.id] = (await safeStorage.encryptStringAsync(pw)).toString('base64');
  } else if (!c.savePassword) {
    delete s[c.id];
  }
  writeJson('secrets.json', s);
  return info(c);
}

export function removeManual(id: string) {
  writeJson('connections.json', conns().filter(c => c.id !== id));
  const s = secrets();
  delete s[id];
  writeJson('secrets.json', s);
  memory.delete(id);
}

/** BE 프로필 비밀번호 저장소 (passwords.ts). 직접 입력 접속과 같은 secrets.json 에 키 이름으로 나눠 둔다 */
export const profileSecretStore: SecretStore = {
  async load(key) {
    const enc = secrets()[key];
    return enc ? (await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))).result : undefined;
  },
  async save(key, password) {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('이 PC 에서는 비밀번호 암호화를 쓸 수 없습니다. 저장하지 않고 쓰세요');
    writeJson('secrets.json', { ...secrets(), [key]: (await safeStorage.encryptStringAsync(password)).toString('base64') });
  },
  async remove(key) {
    const s = secrets();
    if (!(key in s)) return;
    delete s[key];
    writeJson('secrets.json', s);
  },
  has: key => key in secrets(),
};

/** 이번 실행에서 기억한 비밀번호를 지운다 (앱을 다시 켠 것과 같은 상태, 시험용) */
export const forgetSessionPasswords = () => memory.clear();

export async function resolveManual(id: string): Promise<{ conn: ManualConn; password: string }> {
  const conn = conns().find(c => c.id === id);
  if (!conn) throw new Error('접속 정보가 없습니다');
  let password = memory.get(id);
  const enc = secrets()[id];
  if (password === undefined && enc) {
    password = (await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))).result;
    memory.set(id, password);
  }
  if (password === undefined) throw new Error(`「${conn.name}」 비밀번호가 없습니다. 편집에서 비밀번호를 입력하세요`);
  return { conn, password };
}
