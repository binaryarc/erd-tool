// BE 레포의 application-{프로파일}.properties 에서 접속 프로필을 만든다 (설계 5장)
// 비밀번호는 접속할 때만 복호화하고 화면으로 보내지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import type { ProfileInfo } from '../../shared/ipc';
import { DIALECT_LABEL, type Dialect } from '../../shared/dialect/names';
import { decryptValue } from './jasypt';

/** jdbc URL 의 드라이버 이름 → DB 종류, 기본 포트 */
const JDBC: Record<string, { dialect: Dialect; port: number }> = {
  postgresql: { dialect: 'postgresql', port: 5432 },
  sqlserver: { dialect: 'sqlserver', port: 1433 },
  mysql: { dialect: 'mysql', port: 3306 },
  mariadb: { dialect: 'mysql', port: 3306 },
  oracle: { dialect: 'oracle', port: 1521 },
};

/** jdbc URL 읽기. postgresql, mysql: //호스트:포트/DB. sqlserver: //호스트:포트;databaseName=DB. oracle: thin:@호스트:포트/서비스 (또는 :SID) */
export function parseJdbcUrl(url: string): { driver: string; host: string; port?: number; database: string } | null {
  const u = url.replace(/^jdbc:(?:log4jdbc:)?/, '');
  let m = u.match(/^oracle:thin:@(?:\/\/)?([^:/]+)(?::(\d+))?[/:]([^?;]+)/);
  if (m) return { driver: 'oracle', host: m[1], port: m[2] ? Number(m[2]) : undefined, database: m[3] };
  m = u.match(/^sqlserver:\/\/([^:;/\\]+)(?:\\[^:;]+)?(?::(\d+))?(.*)$/);
  if (m) return { driver: 'sqlserver', host: m[1], port: m[2] ? Number(m[2]) : undefined, database: m[3].match(/;database(?:Name)?=([^;]+)/i)?.[1] ?? '' };
  m = u.match(/^(\w+):\/\/([^:/]+)(?::(\d+))?\/([^?;]+)/);
  if (m) return { driver: m[1], host: m[2], port: m[3] ? Number(m[3]) : undefined, database: m[4] };
  return null;
}

/** 쓰기로 여는 프로필 이름. 나머지(test, prod, real 등)는 읽기 전용 (2026-10-22 사용자 결정: test 도 읽기 전용) */
export const DEFAULT_WRITABLE_PROFILES = ['dev', 'local'];
let writable = DEFAULT_WRITABLE_PROFILES;

/** 설정(settings.json 의 writableProfiles)으로 바꾼다. 비우거나 안 주면 기본값 */
export function setWritableProfiles(names: string[] | undefined): void {
  writable = names?.length ? names.map(n => n.toLowerCase()) : DEFAULT_WRITABLE_PROFILES;
}

const PROP_DIRS =['src/main/resources', 'src/main/resources/prop', 'src/main/resources'];

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
    const m = parseJdbcUrl(p['db.url'] ?? '');
    const kind = m ? JDBC[m.driver] : undefined;
    profiles.push({
      name,
      driver: m?.driver ?? '알 수 없음',
      dialect: kind?.dialect,
      host: m?.host ?? '',
      port: m?.port ?? kind?.port ?? 5432,
      database: m?.database ?? '',
      user: p['db.username'] ?? '',
      // 쓰기 허용 목록에 없는 프로필은 모두 읽기 전용 (설계 5장, 12장. 운영 이름이 prod 가 아닌 프로젝트도 막는다)
      readOnly: !writable.includes(name.toLowerCase()),
      passwordRaw: p['db.password'] ?? '',
    });
  }
  return profiles;
}

export function getProfile(beDir: string, name: string): Profile {
  const p = listProfiles(beDir).find(x => x.name === name);
  if (!p) throw new Error(`프로필이 없습니다: ${name}`);
  if (!p.dialect) throw new Error(`지원하지 않는 DB 입니다: ${p.driver} (${Object.values(DIALECT_LABEL).join(', ')} 만 지원)`);
  return p;
}

export const passwordOf = (p: Profile, beDir: string) => decryptValue(p.passwordRaw, beDir);

/** 화면으로 보낼 때 비밀번호 필드를 뺀다 */
export const toInfo = ({ passwordRaw: _omit, ...info }: Profile): ProfileInfo => info;
