// 모델 폴더 읽기, 쓰기 (메인 프로세스 전용)

import fs from 'node:fs/promises';
import path from 'node:path';
import { FUNCTIONS_DIR, INDEX_FILE, parseModel, serializeModel } from '../shared/model/erd-format';
import { emptyLayout, LAYOUT_FILE, parseLayout, serializeLayout, type Layout } from '../shared/model/layout';
import { validateModel } from '../shared/model/validate';
import type { SchemaModel } from '../shared/model/types';
import type { LoadResult, SaveResult } from '../shared/ipc';

const listDir = (dir: string) => fs.readdir(dir).catch(() => [] as string[]);

/** 모델 파일 이름 목록: *.erd 와 functions/*.sql (폴더 기준 상대 경로, / 구분) */
async function modelFiles(dir: string): Promise<string[]> {
  const erd = (await listDir(dir)).filter(f => f.endsWith('.erd'));
  const fns = (await listDir(path.join(dir, FUNCTIONS_DIR))).filter(f => f.endsWith('.sql')).map(f => FUNCTIONS_DIR + f);
  return [...erd, ...fns].sort();
}

export async function loadModel(dir: string): Promise<LoadResult> {
  const files: Record<string, string> = {};
  for (const f of await modelFiles(dir)) files[f] = await fs.readFile(path.join(dir, f), 'utf8');
  const parsed = parseModel(files);
  const errors = validateModel(parsed);

  let layout: Layout = emptyLayout();
  try {
    layout = parseLayout(await fs.readFile(path.join(dir, LAYOUT_FILE), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push({ file: LAYOUT_FILE, line: 0, message: (e as Error).message });
  }
  return { model: parsed.model, layout, errors };
}

/** 내용이 바뀐 파일만 쓰고, 테이블이나 함수가 없어진 파일은 지운다 */
export async function saveModel(dir: string, model: SchemaModel, layout: Layout): Promise<SaveResult> {
  await fs.mkdir(dir, { recursive: true });
  const out: Record<string, string> = { ...serializeModel(model), [LAYOUT_FILE]: serializeLayout(layout) };
  const result: SaveResult = { written: [], unchanged: [], removed: [] };
  for (const [name, text] of Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = path.join(dir, name);
    const old = await fs.readFile(file, 'utf8').catch(() => null);
    if (old === text) { result.unchanged.push(name); continue; }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
    result.written.push(name);
  }
  for (const f of await modelFiles(dir)) {
    if (f !== INDEX_FILE && !(f in out)) {
      await fs.unlink(path.join(dir, f));
      result.removed.push(f);
    }
  }
  return result;
}
