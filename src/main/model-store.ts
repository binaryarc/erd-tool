// 모델 폴더 읽기, 쓰기 (메인 프로세스 전용)

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FUNCTIONS_DIR, INDEX_FILE, parseModel, serializeModel } from '../shared/model/erd-format';
import { emptyLayout, LAYOUT_FILE, parseLayout, serializeLayout, type Layout } from '../shared/model/layout';
import { validateModel } from '../shared/model/validate';
import type { SchemaModel } from '../shared/model/types';
import type { LoadResult, SavePlan, SaveResult } from '../shared/ipc';

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

/**
 * 저장하면 무엇이 바뀌는지만 본다 (쓰지 않는다). 「ERD 저장」 이 먼저 보여 주고 확인을 받는다 (2026-10-16 사용자 지정).
 * added 는 새로 생길 파일, changed 는 내용이 바뀔 파일, removed 는 이 모델에 없어 지울 모델 파일(.erd, functions/*.sql)
 */
export async function planSave(dir: string, model: SchemaModel, layout: Layout): Promise<SavePlan & { out: Record<string, string> }> {
  const out: Record<string, string> = { ...serializeModel(model), [LAYOUT_FILE]: serializeLayout(layout) };
  const plan: SavePlan = { added: [], changed: [], unchanged: [], removed: [] };
  for (const name of Object.keys(out).sort()) {
    const old = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (old === null) plan.added.push(name);
    else if (old === out[name]) plan.unchanged.push(name);
    else plan.changed.push(name);
  }
  for (const f of await modelFiles(dir)) if (f !== INDEX_FILE && !(f in out)) plan.removed.push(f);
  return { ...plan, out };
}

/** 내용이 바뀐 파일만 쓰고, 테이블이나 함수가 없어진 파일은 지운다 */
export async function saveModel(dir: string, model: SchemaModel, layout: Layout): Promise<SaveResult> {
  await fs.mkdir(dir, { recursive: true });
  const { out, added, changed, unchanged, removed } = await planSave(dir, model, layout);
  const written = [...added, ...changed].sort();
  for (const name of written) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // 임시 파일에 쓰고 바꿔 끼운다 (쓰는 도중 꺼지거나 디스크가 차도 앞 내용이 남게. settings.ts 와 같은 방식)
    try {
      await fs.writeFile(file + '.tmp', out[name], 'utf8');
      await fs.rename(file + '.tmp', file);
    } catch (e) {
      await fs.unlink(file + '.tmp').catch(() => {});
      throw e;
    }
  }
  for (const f of removed) await fs.unlink(path.join(dir, f));
  return { written, unchanged, removed };
}

/** 「ERD 폴더 열기」 에서 고른 파일의 모델 폴더: 그 파일의 폴더. functions/ 안 파일이면 그 위 폴더. hasModel 은 _index.erd 가 있는지 */
export function modelDirOfFile(file: string): { dir: string; hasModel: boolean } {
  const has = (d: string) => existsSync(path.join(d, INDEX_FILE));
  let dir = path.dirname(file);
  if (!has(dir) && has(path.dirname(dir))) dir = path.dirname(dir);
  return { dir, hasModel: has(dir) };
}
