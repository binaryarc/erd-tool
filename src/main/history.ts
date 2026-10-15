// 쿼리 이력 (설계 9장): 접속별 파일, 리터럴은 ? 로 바꿔 저장, 같은 문장은 횟수만 올린다.

import fs from 'node:fs';
import path from 'node:path';
import type { HistoryEntry } from '../shared/ipc';
import { stripLiterals } from '../shared/sql/text';

const MAX = 500;
let baseDir = '';

export function setHistoryDir(dir: string) { baseDir = dir; }

const file = (key: string) => path.join(baseDir, `${key.replace(/[^\w.-]/g, '_')}.json`);

export function listHistory(key: string): HistoryEntry[] {
  try { return JSON.parse(fs.readFileSync(file(key), 'utf8')) as HistoryEntry[]; } catch { return []; }
}

export function addHistory(key: string, sql: string) {
  const s = stripLiterals(sql).replace(/;\s*$/, '');
  if (!s) return;
  const list = listHistory(key).filter(e => e.sql !== s);
  const old = listHistory(key).find(e => e.sql === s);
  list.unshift({ sql: s, count: (old?.count ?? 0) + 1, last: new Date().toISOString() });
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(file(key), JSON.stringify(list.slice(0, MAX), null, 1), 'utf8');
}
