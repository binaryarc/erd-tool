// Jasypt ENC(...) 복호화 — PBEWithMD5AndDES, 고정 salt (STEP 1 시험으로 허브 db-target.ps1 과 같은 결과 확인)
// 마스터키는 환경변수 JASYPT_ENCRYPTOR_PASSWORD(없으면 Windows 사용자 환경변수)에서만 읽고 어디에도 남기지 않는다.
// Node 내장 crypto 의 des-cbc 는 OpenSSL 3 기본 설정에서 막혀 있어 crypto-js 를 쓴다.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import CryptoJS from 'crypto-js';

const ITERATIONS = 1000; // jasypt StandardPBEByteEncryptor 기본값
const SALT_BYTES = 8;

function masterKey(): string {
  const env = process.env.JASYPT_ENCRYPTOR_PASSWORD;
  if (env) return env;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'JASYPT_ENCRYPTOR_PASSWORD'], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/JASYPT_ENCRYPTOR_PASSWORD\s+REG_\w+\s+(.+)/);
      if (m) return m[1].trim();
    } catch { /* 없음 */ }
  }
  throw new Error('JASYPT_ENCRYPTOR_PASSWORD 환경변수가 없다');
}

function findEncryptorConfig(beDir: string): string {
  const stack = [path.join(beDir, 'src', 'main', 'java')];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'EncryptorConfig.java') return p;
    }
  }
  throw new Error(`EncryptorConfig.java 를 찾지 못했다: ${beDir}`);
}

/** ENC(...) 가 아니면 그대로 돌려준다 */
export function decryptValue(value: string, beDir: string): string {
  const m = value.match(/^ENC\((.+)\)$/);
  if (!m) return value;
  const src = fs.readFileSync(findEncryptorConfig(beDir), 'utf8');
  const alg = src.match(/setAlgorithm\("([^"]+)"\)/)?.[1] ?? src.match(/ALGORITHM\s*=\s*"([^"]+)"/)?.[1];
  const salt = src.match(/StringFixedSaltGenerator\("([^"]+)"\)/)?.[1] ?? src.match(/SALT\s*=\s*"([^"]+)"/)?.[1];
  if (alg !== 'PBEWithMD5AndDES' || !salt) throw new Error(`지원하지 않는 Jasypt 설정: ${alg ?? '알고리즘 없음'}`);

  // PBKDF1(MD5): MD5(키 || salt) 를 반복, 앞 8바이트 키, 뒤 8바이트 IV
  let h = crypto.createHash('md5').update(Buffer.concat([Buffer.from(masterKey(), 'utf8'), Buffer.from(salt, 'utf8').subarray(0, SALT_BYTES)])).digest();
  for (let i = 1; i < ITERATIONS; i++) h = crypto.createHash('md5').update(h).digest();
  const out = CryptoJS.DES.decrypt(
    CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Base64.parse(m[1]) }),
    CryptoJS.enc.Hex.parse(h.subarray(0, 8).toString('hex')),
    { iv: CryptoJS.enc.Hex.parse(h.subarray(8, 16).toString('hex')), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
  ).toString(CryptoJS.enc.Utf8);
  if (!out) throw new Error('복호화 결과가 비었다 (마스터키가 다를 수 있다)');
  return out;
}
