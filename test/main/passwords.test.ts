import { beforeEach, describe, expect, it } from 'vitest';
import { forgetPassword, hasSavedPassword, markWrong, passwordFor, setPasswordAsker, setSecretStore, type PasswordRequest, type SecretStore } from '../../src/main/db/passwords';

let saved: Map<string, string>;
let asked: PasswordRequest[];
let answers: ({ password: string; save: boolean } | null)[];
const store: SecretStore = {
  load: async k => saved.get(k), save: async (k, p) => { saved.set(k, p); }, remove: async k => { saved.delete(k); }, has: k => saved.has(k),
};
let n = 0;
const key = () => `be:test:${++n}`; // 시험마다 다른 키 (모듈의 메모리를 나눠 쓰지 않게)

beforeEach(() => {
  saved = new Map(); asked = []; answers = [];
  setSecretStore(store);
  setPasswordAsker(async r => { asked.push(r); return answers.shift() ?? null; });
});

describe('BE 프로필 비밀번호', () => {
  it('properties 에서 자동으로 읽히면 묻지 않는다 (평문, 복호화)', async () => {
    const k = key();
    expect(await passwordFor(k, 'dev', () => 'auto-pw')).toBe('auto-pw');
    expect(asked).toEqual([]);
  });

  it('자동으로 풀지 못하면 까닭과 함께 묻고, 저장을 고르면 다음부터 자동보다 먼저 쓴다', async () => {
    const k = key();
    answers.push({ password: 'typed', save: true });
    expect(await passwordFor(k, 'dev (shop-dev)', () => { throw new Error('JASYPT_ENCRYPTOR_PASSWORD 환경변수가 없다'); })).toBe('typed');
    expect(asked[0]).toEqual({ key: k, label: 'dev (shop-dev)', reason: 'BE 폴더 설정에서 비밀번호를 자동으로 풀지 못했습니다: JASYPT_ENCRYPTOR_PASSWORD 환경변수가 없다' });
    expect(hasSavedPassword(k)).toBe(true);
    await forgetPassword(k);
    expect(hasSavedPassword(k)).toBe(false);
    expect(await passwordFor(k, 'dev', () => 'auto-pw')).toBe('auto-pw'); // 지우면 다시 자동부터
  });

  it('DB 가 거부하면 자동 값도 건너뛰고 「틀렸다」 며 다시 묻는다. 저장하지 않으면 저장소에 남기지 않는다', async () => {
    const k = key();
    expect(await passwordFor(k, 'dev', () => 'auto-pw')).toBe('auto-pw');
    await markWrong(k);
    answers.push({ password: 'right', save: false });
    expect(await passwordFor(k, 'dev', () => 'auto-pw')).toBe('right');
    expect(asked[0].reason).toContain('틀렸습니다');
    expect(saved.has(k)).toBe(false);
    expect(await passwordFor(k, 'dev', () => 'auto-pw')).toBe('right'); // 이 실행 동안은 기억
  });

  it('취소하면 오류, 같은 접속을 동시에 열면 한 번만 묻는다', async () => {
    const k = key();
    const fail = () => { throw new Error('x'); };
    await expect(passwordFor(k, 'test', fail)).rejects.toThrow('test 비밀번호 입력을 취소했습니다');
    answers.push({ password: 'p', save: false });
    const both = await Promise.all([passwordFor(k, 'test', fail), passwordFor(k, 'test', fail)]);
    expect(both).toEqual(['p', 'p']);
    expect(asked).toHaveLength(2); // 취소 1번 + 동시 두 요청에 1번
  });

  it('묻는 곳이 없으면 (시험, 화면 없음) 까닭을 오류로', async () => {
    setPasswordAsker(null);
    await expect(passwordFor(key(), 'dev', () => { throw new Error('지원하지 않는 Jasypt 설정'); })).rejects.toThrow('자동으로 풀지 못했습니다: 지원하지 않는 Jasypt 설정');
  });
});
