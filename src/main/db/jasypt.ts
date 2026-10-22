// Jasypt ENC(...) 복호화 — PBEWithMD5AndDES (Jasypt 2.x 기본 방식)만 지원한다.
// 방식은 설정 파일의 표준 키 jasypt.encryptor.algorithm 으로 정하고, 없으면 BE 소스의 Jasypt 설정(setAlgorithm)을 본다.
// 둘 다 없으면 jasypt-spring-boot 3 기본값(PBEWITHHMACSHA512ANDAES_256)이라 보고 지원하지 않는다.
// salt 는 표준(RandomSaltGenerator)대로 암호문 앞 8바이트에서 꺼낸다. BE 소스가 고정 salt(StringFixedSaltGenerator)를 쓰면 그 값을 쓴다 (2026-10-22).
// 마스터키는 환경변수 JASYPT_ENCRYPTOR_PASSWORD(없으면 Windows 사용자 환경변수)에서만 읽고 어디에도 남기지 않는다.
// 풀지 못하면 오류를 던지고, 그때는 화면이 비밀번호를 묻는다(passwords.ts).
// Node 내장 crypto 의 des-cbc 는 OpenSSL 3 기본 설정에서 막혀 있어 crypto-js 를 쓴다.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import CryptoJS from 'crypto-js';

const DEFAULT_ITERATIONS = 1000; // jasypt key-obtention-iterations 기본값
const SALT_BYTES = 8;
const SUPPORTED = 'PBEWithMD5AndDES';
/** jasypt-spring-boot 3 의 기본 방식 (설정이 없을 때) */
const LIB_DEFAULT = 'PBEWITHHMACSHA512ANDAES_256';

/** 설정 파일의 jasypt.encryptor.* 값 (프로필별) */
export interface JasyptProps { algorithm?: string; iterations?: string }

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
  throw new Error('JASYPT_ENCRYPTOR_PASSWORD 환경변수가 없습니다');
}

/** BE 소스의 Jasypt 설정 (Java 설정 클래스로 정하는 프로젝트). 이름에 jasypt, encrypt 가 든 .java 파일만 읽는다. BE 폴더마다 한 번 */
const sourceCache = new Map<string, { algorithm?: string; salt?: string }>();
function sourceConfig(beDir: string): { algorithm?: string; salt?: string } {
  const hit = sourceCache.get(beDir);
  if (hit) return hit;
  const out: { algorithm?: string; salt?: string } = {};
  const stack = [path.join(beDir, 'src', 'main', 'java')];
  while (stack.length && !(out.algorithm && out.salt)) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.java$/i.test(e.name) && /jasypt|encrypt/i.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        out.algorithm ??= src.match(/setAlgorithm\("([^"]+)"\)/)?.[1] ?? src.match(/ALGORITHM\s*=\s*"([^"]+)"/)?.[1];
        out.salt ??= src.match(/StringFixedSaltGenerator\("([^"]+)"\)/)?.[1] ?? src.match(/SALT\s*=\s*"([^"]+)"/)?.[1];
      }
    }
  }
  sourceCache.set(beDir, out);
  return out;
}

/** PBEWithMD5AndDES 복호화. salt 가 없으면 암호문 앞 8바이트가 salt (표준 RandomSaltGenerator) */
export function decryptPbeMd5Des(encBase64: string, password: string, fixedSalt?: string, iterations = DEFAULT_ITERATIONS): string {
  const raw = Buffer.from(encBase64, 'base64');
  const salt = fixedSalt !== undefined ? Buffer.from(fixedSalt, 'utf8').subarray(0, SALT_BYTES) : raw.subarray(0, SALT_BYTES);
  const body = fixedSalt !== undefined ? raw : raw.subarray(SALT_BYTES);
  // PBKDF1(MD5): MD5(키 || salt) 를 반복, 앞 8바이트 키, 뒤 8바이트 IV
  let h = crypto.createHash('md5').update(Buffer.concat([Buffer.from(password, 'utf8'), salt])).digest();
  for (let i = 1; i < iterations; i++) h = crypto.createHash('md5').update(h).digest();
  let out = '';
  try {
    out = CryptoJS.DES.decrypt(
      CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Base64.parse(body.toString('base64')) }),
      CryptoJS.enc.Hex.parse(h.subarray(0, 8).toString('hex')),
      { iv: CryptoJS.enc.Hex.parse(h.subarray(8, 16).toString('hex')), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
    ).toString(CryptoJS.enc.Utf8);
  } catch { /* 키가 틀리면 글자로 바꾸지 못해 오류가 난다 (Malformed UTF-8 data) */ }
  if (!out) throw new Error('복호화하지 못했습니다 (마스터키가 다를 수 있습니다)');
  return out;
}

/** ENC(...) 가 아니면 그대로 돌려준다 */
export function decryptValue(value: string, beDir: string, props: JasyptProps = {}): string {
  const m = value.match(/^ENC\((.+)\)$/);
  if (!m) return value;
  const src = sourceConfig(beDir);
  const alg = props.algorithm ?? src.algorithm ?? LIB_DEFAULT;
  if (alg.toLowerCase() !== SUPPORTED.toLowerCase()) throw new Error(`지원하지 않는 Jasypt 방식: ${alg} (${SUPPORTED} 만 자동으로 풉니다)`);
  const iterations = Number(props.iterations) || DEFAULT_ITERATIONS;
  return decryptPbeMd5Des(m[1], masterKey(), src.salt, iterations);
}
