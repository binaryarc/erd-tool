// 시험 전에 test/.env.local (git 에 올리지 않는 이 PC 전용 값)을 process.env 로 읽는다. 이미 있는 환경변수가 이긴다.
// DB 시험이 쓰는 BE 폴더(ERD_BE_DIR)를 코드에 적지 않으려는 것이다. 형식은 test/.env.example
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../.env.local', import.meta.url));
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    // 값 뒤의 「 # 설명」 은 뗀다 (값 안의 # 은 %23 처럼 인코딩해 둔다)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '');
  }
}
