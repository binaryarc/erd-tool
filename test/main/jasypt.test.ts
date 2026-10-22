// Jasypt ENC(...) 복호화. 암호문은 Java Jasypt 1.9.3 으로 만든 시험용 값이다 (마스터키 test-master, 원문 hello-db)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptPbeMd5Des, decryptValue } from '../../src/main/db/jasypt';

const RANDOM_SALT = 't55ZuLJtm9WJHZSWzZwaz8RZdJiPNY79';
const FIXED_SALT = 'eBE8fsQ7UfMLMmHd043uzQ==';

/** src/main/java 아래 Java 설정 파일이 있는(또는 없는) 시험용 BE 폴더 */
const be = (java?: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-be-'));
  const src = path.join(dir, 'src/main/java/app/config');
  fs.mkdirSync(src, { recursive: true });
  for (const [f, s] of Object.entries(java ?? {})) fs.writeFileSync(path.join(src, f), s);
  return dir;
};

describe('Jasypt 복호화', () => {
  const saved = process.env.JASYPT_ENCRYPTOR_PASSWORD;
  afterEach(() => { process.env.JASYPT_ENCRYPTOR_PASSWORD = saved; });

  it('표준(무작위 salt) PBEWithMD5AndDES 는 암호문 앞 8바이트를 salt 로 쓴다', () => {
    expect(decryptPbeMd5Des(RANDOM_SALT, 'test-master')).toBe('hello-db');
  });

  it('고정 salt 를 주면 암호문 전체가 본문이다', () => {
    expect(decryptPbeMd5Des(FIXED_SALT, 'test-master', 'example-salt')).toBe('hello-db');
  });

  it('방식은 설정 키 jasypt.encryptor.algorithm 으로 정하고, 마스터키는 환경변수에서 읽는다', () => {
    process.env.JASYPT_ENCRYPTOR_PASSWORD = 'test-master';
    expect(decryptValue(`ENC(${RANDOM_SALT})`, be(), { algorithm: 'PBEWithMD5AndDES' })).toBe('hello-db');
  });

  it('설정 키가 없으면 BE 소스의 Jasypt 설정(파일 이름에 jasypt, encrypt)에서 방식과 고정 salt 를 읽는다', () => {
    process.env.JASYPT_ENCRYPTOR_PASSWORD = 'test-master';
    const dir = be({ 'EncryptorSetup.java': 'c.setAlgorithm("PBEWithMD5AndDES");\nc.setSaltGenerator(new StringFixedSaltGenerator("example-salt"));\n' });
    expect(decryptValue(`ENC(${FIXED_SALT})`, dir)).toBe('hello-db');
  });

  it('방식을 정한 곳이 없으면 jasypt-spring-boot 기본(AES)이라 보고 풀지 않는다 (화면이 비밀번호를 묻는다)', () => {
    process.env.JASYPT_ENCRYPTOR_PASSWORD = 'test-master';
    expect(() => decryptValue(`ENC(${RANDOM_SALT})`, be())).toThrow('지원하지 않는 Jasypt 방식: PBEWITHHMACSHA512ANDAES_256');
  });

  it('ENC(...) 가 아니면 그대로', () => {
    expect(decryptValue('plain', be())).toBe('plain');
  });
});
