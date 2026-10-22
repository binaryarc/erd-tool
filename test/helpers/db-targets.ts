// DB 종류별 시험 접속 정보를 환경변수(보통 test/.env.local)의 URL 에서 읽는다. 비밀번호를 코드에 적지 않으려는 것이다.
// 형식: {아무 이름}://{계정}:{비밀번호}@{호스트}:{포트}/{DB 또는 서비스}. 비밀번호의 # 같은 글자는 %23 처럼 URL 인코딩한다.
// 값이 없으면 undefined 를 돌려주고, 시험은 그 DB 를 건너뛴다.
import type { Target } from '../../src/main/db/adapters/types';
import type { Dialect } from '../../src/shared/dialect/names';

export function envTarget(key: string, dialect: Dialect, extra: Partial<Target> = {}): Target | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;
  const u = new URL(raw);
  return {
    dialect, host: u.hostname, port: Number(u.port), database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), readOnly: false, ...extra,
  };
}

/** 건너뛸 때 알릴 말 */
export const missing = (key: string) => `test/.env.local 에 ${key} 가 없다 (형식은 test/.env.example)`;
