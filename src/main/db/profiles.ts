// BE 레포의 application-{프로파일}.properties (또는 .yml, .yaml) 에서 접속 프로필을 만든다 (설계 5장)
// 키는 Spring 표준 spring.datasource.url, username, password 를 먼저 보고, 없으면 값이 jdbc: 로 시작하는 {앞}.url 키를 찾아
// 같은 앞부분의 {앞}.username, {앞}.password 를 쓴다 (2026-10-22. 프로젝트 고유 키 이름을 코드에 정해 두지 않는다)
// 비밀번호는 접속할 때만 복호화하고 화면으로 보내지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { FAILSAFE_SCHEMA, loadAll } from 'js-yaml';
import type { ProfileInfo } from '../../shared/ipc';
import { DIALECT_LABEL, type Dialect } from '../../shared/dialect/names';
import { decryptValue, type JasyptProps } from './jasypt';
import { mainDirs } from '../be-dirs';

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

export interface Profile extends ProfileInfo {
  passwordRaw: string;
  /** 설정 파일의 jasypt.encryptor.algorithm, key-obtention-iterations (ENC 복호화 방식) */
  jasypt: JasyptProps;
}

function readProps(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** yml 을 점으로 이은 키(spring.datasource.url)로 편다. 값은 모두 글자로 읽는다(FAILSAFE: 0123 이 123 이 되지 않게). 문서(---)가 여럿이면 뒤가 이긴다 */
function readYaml(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (v: unknown, key: string) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}.${k}` : k);
    else if (typeof v === 'string' && key) out[key] = v;
  };
  for (const doc of loadAll(fs.readFileSync(file, 'utf8'), undefined, { schema: FAILSAFE_SCHEMA })) walk(doc, '');
  return out;
}

/** 접속 키의 앞부분: spring.datasource 가 있으면 그것, 없으면 값이 jdbc: 로 시작하는 첫 {앞}.url 키의 앞 */
export function datasourcePrefix(c: Record<string, string>): string {
  if (c['spring.datasource.url']) return 'spring.datasource';
  const k = Object.keys(c).sort().find(x => x.endsWith('.url') && /^\s*jdbc:/i.test(c[x]));
  return k ? k.slice(0, -'.url'.length) : 'spring.datasource';
}

const PROFILE_FILE = /^application-(\w+)\.(properties|ya?ml)$/;
const BASE_FILE = /^application\.(properties|ya?ml)$/;

export function listProfiles(beDir: string): Profile[] {
  const hasProfiles = (d: string) => fs.existsSync(d) && fs.readdirSync(d).some(f => PROFILE_FILE.test(f));
  // 설정 파일 폴더: 표준 src/main/resources 먼저, 없으면 src/main 아래 프로필 파일이 있는 첫 폴더
  const dir = mainDirs(beDir).find(hasProfiles);
  if (!dir) return [];
  // 같은 프로필의 yml 과 properties 가 함께 있으면 Spring 처럼 properties 가 이긴다 (yml 을 먼저 읽고 덮는다)
  // 공통 파일 application.properties(.yml) 의 값은 프로필 값이 덮는다 (Spring 과 같다. 공통 파일에 둔 jasypt.encryptor.* 도 읽힌다)
  const byName = new Map<string, Record<string, string>>();
  let base: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).sort((a, b) => Number(a.endsWith('.properties')) - Number(b.endsWith('.properties')) || a.localeCompare(b))) {
    const file = path.join(dir, f);
    const bm = f.match(BASE_FILE);
    if (bm) { base = { ...base, ...(bm[1] === 'properties' ? readProps(file) : readYaml(file)) }; continue; }
    const fm = f.match(PROFILE_FILE);
    if (!fm) continue;
    byName.set(fm[1], { ...byName.get(fm[1]), ...(fm[2] === 'properties' ? readProps(file) : readYaml(file)) });
  }
  const profiles: Profile[] = [];
  for (const name of [...byName.keys()].sort()) {
    const c = { ...base, ...byName.get(name)! };
    const pre = datasourcePrefix(c);
    const p = { url: c[pre + '.url'], user: c[pre + '.username'], password: c[pre + '.password'] };
    const m = parseJdbcUrl(p.url ?? '');
    const kind = m ? JDBC[m.driver] : undefined;
    profiles.push({
      name,
      driver: m?.driver ?? '알 수 없음',
      dialect: kind?.dialect,
      host: m?.host ?? '',
      port: m?.port ?? kind?.port ?? 5432,
      database: m?.database ?? '',
      user: p.user ?? '',
      // 쓰기 허용 목록에 없는 프로필은 모두 읽기 전용 (설계 5장, 12장. 운영 이름이 prod 가 아닌 프로젝트도 막는다)
      readOnly: !writable.includes(name.toLowerCase()),
      passwordRaw: p.password ?? '',
      jasypt: { algorithm: c['jasypt.encryptor.algorithm'], iterations: c['jasypt.encryptor.key-obtention-iterations'] },
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

export const passwordOf = (p: Profile, beDir: string) => decryptValue(p.passwordRaw, beDir, p.jasypt);

/** 화면으로 보낼 때 비밀번호 필드를 뺀다 */
export const toInfo = ({ passwordRaw: _omit, jasypt: _j, ...info }: Profile): ProfileInfo => info;
