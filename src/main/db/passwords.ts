// BE 폴더 프로필의 DB 비밀번호를 정하는 곳 (2026-10-16 사용자 지정).
// 순서: 사용자가 입력해 기억한 값 → properties 에서 자동으로 읽은 값(평문 그대로, ENC() 는 Jasypt 로 풂) → 화면에 묻기.
// 자동으로 풀지 못하거나(마스터키 없음, 지원하지 않는 방식) DB 가 비밀번호를 거부하면 화면에 묻는다.
// 「저장」을 고르면 Windows 계정 암호화 저장소에, 아니면 이 실행의 메모리에만 둔다.
// Electron 을 쓰지 않는다: 묻는 방법(asker)과 저장소(store)는 메인이 넣어 준다. 시험은 환경변수로 답하는 asker 를 넣는다.

export interface PasswordRequest {
  key: string;
  /** 화면에 보일 접속 이름 (예: dev (shop-dev)) */
  label: string;
  /** 묻는 까닭: 자동으로 풀지 못함, 비밀번호가 틀림 */
  reason: string;
}
export type PasswordAsker = (r: PasswordRequest) => Promise<{ password: string; save: boolean } | null>;
export interface SecretStore {
  load(key: string): Promise<string | undefined>;
  save(key: string, password: string): Promise<void>;
  remove(key: string): Promise<void>;
  has(key: string): boolean;
}

const memory = new Map<string, string>();
/** DB 가 거부한 접속. 다음에는 자동 값도 쓰지 않고 바로 묻는다 */
const wrong = new Set<string>();
/** 같은 접속을 동시에 열 때(비교 탭의 두 쪽, 자동완성 목록과 SQL 탭) 한 번만 묻는다 */
const asking = new Map<string, Promise<string>>();
let asker: PasswordAsker | null = null;
let store: SecretStore | null = null;

export const setPasswordAsker = (a: PasswordAsker | null) => { asker = a; };
export const setSecretStore = (s: SecretStore | null) => { store = s; };

/** auto: properties 에서 비밀번호를 읽어 오는 함수 (풀지 못하면 오류를 던진다) */
export async function passwordFor(key: string, label: string, auto?: () => string): Promise<string> {
  let reason = '비밀번호가 틀렸습니다 (DB 가 거부). 다시 입력하세요';
  if (!wrong.has(key)) {
    const m = memory.get(key);
    if (m !== undefined) return m;
    const s = await store?.load(key);
    if (s !== undefined) { memory.set(key, s); return s; }
    if (auto) {
      try { const v = auto(); memory.set(key, v); return v; }
      catch (e) { reason = `BE 폴더 설정에서 비밀번호를 자동으로 풀지 못했습니다: ${(e as Error).message}`; }
    } else reason = '저장된 비밀번호가 없습니다';
  }
  const pending = asking.get(key);
  if (pending) return pending;
  const p = (async () => {
    if (!asker) throw new Error(`${label}: ${reason}`);
    const a = await asker({ key, label, reason });
    if (!a) throw new Error(`${label} 비밀번호 입력을 취소했습니다`);
    wrong.delete(key);
    memory.set(key, a.password);
    if (a.save) await store?.save(key, a.password);
    else await store?.remove(key);
    return a.password;
  })();
  asking.set(key, p);
  try { return await p; } finally { asking.delete(key); }
}

/** DB 가 비밀번호를 거부했다: 기억한 값을 지우고 다음 접속에서 다시 묻는다 */
export async function markWrong(key: string) {
  memory.delete(key);
  wrong.add(key);
  await store?.remove(key);
}

/** 사용자가 저장한 비밀번호를 지운다 (다음 접속은 다시 자동 값부터) */
export async function forgetPassword(key: string) {
  memory.delete(key);
  wrong.delete(key);
  await store?.remove(key);
}

/** 사용자가 입력해 저장한 비밀번호가 있는가 */
export const hasSavedPassword = (key: string) => !!store?.has(key);
