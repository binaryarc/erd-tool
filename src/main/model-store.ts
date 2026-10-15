// 모델 폴더 읽기, 쓰기 (메인 프로세스 전용)

import fs from 'node:fs/promises';
import path from 'node:path';
import { INDEX_FILE, parseModel, serializeModel } from '../shared/model/erd-format';
import { emptyLayout, LAYOUT_FILE, parseLayout, serializeLayout, type Layout } from '../shared/model/layout';
import { validateModel } from '../shared/model/validate';
import type { SchemaModel } from '../shared/model/types';
import type { LoadResult, SaveResult } from '../shared/ipc';

export async function loadModel(dir: string): Promise<LoadResult> {
  const names = (await fs.readdir(dir)).filter(f => f.endsWith('.erd')).sort();
  const files: Record<string, string> = {};
  for (const f of names) files[f] = await fs.readFile(path.join(dir, f), 'utf8');
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

/** 내용이 바뀐 파일만 쓰고, 테이블이 없어진 그룹 파일은 지운다 */
export async function saveModel(dir: string, model: SchemaModel, layout: Layout): Promise<SaveResult> {
  await fs.mkdir(dir, { recursive: true });
  const out = { ...serializeModel(model), [LAYOUT_FILE]: serializeLayout(layout) };
  const result: SaveResult = { written: [], unchanged: [], removed: [] };
  for (const [name, text] of Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = path.join(dir, name);
    const old = await fs.readFile(file, 'utf8').catch(() => null);
    if (old === text) { result.unchanged.push(name); continue; }
    await fs.writeFile(file, text, 'utf8');
    result.written.push(name);
  }
  for (const f of await fs.readdir(dir)) {
    if (f.endsWith('.erd') && f !== INDEX_FILE && !(f in out)) {
      await fs.unlink(path.join(dir, f));
      result.removed.push(f);
    }
  }
  return result;
}
