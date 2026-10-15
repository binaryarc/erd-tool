// BE 레포의 application-{프로파일}.properties 에서 접속 프로필을 만든다 (설계 5장)
// 비밀번호는 접속할 때만 복호화하고 화면으로 보내지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import type { ProfileInfo } from '../../shared/ipc';
import { decryptValue } from './jasypt';

const PROP_DIRS = ['src/main/resources', 'src/main/resources/prop', 'src/main/resources'];

export interface Profile extends ProfileInfo {
  passwordRaw: string;
}

function readProps(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function listProfiles(beDir: string): Profile[] {
  const dir = PROP_DIRS.map(d => path.join(beDir, d)).find(d => fs.existsSync(d));
  if (!dir) return [];
  const profiles: Profile[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const name = f.match(/^application-(\w+)\.properties$/)?.[1];
    if (!name) continue;
    const p = readProps(path.join(dir, f));
    const url = p['db.url'] ?? '';
    const m = url.match(/^jdbc:(?:log4jdbc:)?(\w+):\/\/([^:/]+)(?::(\d+))?\/([^?;]+)/);
    profiles.push({
      name,
      driver: m?.[1] ?? '알 수 없음',
      host: m?.[2] ?? '',
      port: m?.[3] ? Number(m[3]) : 5432,
      database: m?.[4] ?? '',
      user: p['db.username'] ?? '',
      // 운영 접속은 기본 읽기 전용 (설계 5장, 12장)
      readOnly: name === 'prod',
      passwordRaw: p['db.password'] ?? '',
    });
  }
  return profiles;
}

export function getProfile(beDir: string, name: string): Profile {
  const p = listProfiles(beDir).find(x => x.name === name);
  if (!p) throw new Error(`프로필이 없다: ${name}`);
  if (p.driver !== 'postgresql') throw new Error(`아직 지원하지 않는 DB: ${p.driver} (STEP 7)`);
  return p;
}

export const passwordOf = (p: Profile, beDir: string) => decryptValue(p.passwordRaw, beDir);

/** 화면으로 보낼 때 비밀번호 필드를 뺀다 */
export const toInfo = ({ passwordRaw: _omit, ...info }: Profile): ProfileInfo => info;
