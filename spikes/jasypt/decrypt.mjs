// STEP 1 시험: Jasypt PBEWithMD5AndDES(고정 salt) 복호화를 Node 로 재현하고 pg 로 접속한다.
// 마스터키는 환경변수 JASYPT_ENCRYPTOR_PASSWORD 에서만 읽고, 비밀번호는 출력하지 않는다(sha256 앞 12자만).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import CryptoJS from 'crypto-js';
import pg from 'pg';

const BE = process.argv[2] ?? 'C:/work/workspace/shop-be';
const profile = process.argv[3] ?? 'dev'; // 개발 중에는 dev DB 를 쓴다 (사용자 지정 2026-10-15)
const ITERATIONS = 1000; // jasypt StandardPBEByteEncryptor 기본값
const SALT_BYTES = 8;    // PBEWithMD5AndDES 블록 크기

function masterKey() {
  if (process.env.JASYPT_ENCRYPTOR_PASSWORD) return process.env.JASYPT_ENCRYPTOR_PASSWORD;
  // Windows 사용자 환경변수 (프로세스에 없을 때)
  const out = execSync('reg query HKCU\\Environment /v JASYPT_ENCRYPTOR_PASSWORD', { encoding: 'utf8' });
  const m = out.match(/JASYPT_ENCRYPTOR_PASSWORD\s+REG_\w+\s+(.+)/);
  if (!m) throw new Error('JASYPT_ENCRYPTOR_PASSWORD 없음');
  return m[1].trim();
}

function jasyptConfig() {
  const src = fs.readFileSync(`${BE}/src/main/java/fw/config/EncryptorConfig.java`, 'utf8');
  const alg = src.match(/ALGORITHM\s*=\s*"([^"]+)"/)[1];
  const salt = src.match(/SALT\s*=\s*"([^"]+)"/)[1];
  if (alg !== 'PBEWithMD5AndDES') throw new Error(`지원하지 않는 알고리즘: ${alg}`);
  return { salt: Buffer.from(salt, 'utf8').subarray(0, SALT_BYTES) };
}

// PBKDF1(MD5): MD5(password || salt) 를 ITERATIONS 번 반복, 앞 8바이트 키, 뒤 8바이트 IV
function deriveKeyIv(password, salt) {
  let h = crypto.createHash('md5').update(Buffer.concat([Buffer.from(password, 'utf8'), salt])).digest();
  for (let i = 1; i < ITERATIONS; i++) h = crypto.createHash('md5').update(h).digest();
  return { key: h.subarray(0, 8), iv: h.subarray(8, 16) };
}

function decryptNode(b64, key, iv) {
  const d = crypto.createDecipheriv('des-cbc', key, iv);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
}

function decryptPureJs(b64, key, iv) {
  const out = CryptoJS.DES.decrypt(
    { ciphertext: CryptoJS.enc.Base64.parse(b64) },
    CryptoJS.enc.Hex.parse(key.toString('hex')),
    { iv: CryptoJS.enc.Hex.parse(iv.toString('hex')), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
  return out.toString(CryptoJS.enc.Utf8);
}

const props = Object.fromEntries(
  fs.readFileSync(`${BE}/src/main/resources/application-${profile}.properties`, 'utf8')
    .split(/\r?\n/).filter(l => /^db\.(url|username|password)=/.test(l))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

const enc = props['db.password'].match(/^ENC\((.+)\)$/)[1];
const { key, iv } = deriveKeyIv(masterKey(), jasyptConfig().salt);
const fp = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

let nodeResult = null;
try { nodeResult = decryptNode(enc, key, iv); console.log('node:crypto des-cbc  ok   fp=' + fp(nodeResult)); }
catch (e) { console.log('node:crypto des-cbc  FAIL ' + e.message); }
const jsResult = decryptPureJs(enc, key, iv);
console.log('crypto-js DES         ' + (jsResult ? 'ok   fp=' + fp(jsResult) : 'FAIL 빈 결과'));

const m = props['db.url'].match(/postgresql:\/\/([^:/]+):(\d+)\/([^?]+)/);
const client = new pg.Client({ host: m[1], port: +m[2], database: m[3], user: props['db.username'], password: jsResult });
await client.connect();
const r = await client.query(`select current_database() db,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='public')::int tables,
  (select count(*) from pg_constraint where contype='f')::int fks`);
console.log('pg connect ok', JSON.stringify(r.rows[0]));
await client.end();
