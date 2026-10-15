// 통합 시험: dev DB 리버스 (STEP 3 완료 기준). BE 폴더나 마스터키가 없으면 건너뛴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reverse } from '../../src/main/db/reverse';
import { getProfile, passwordOf } from '../../src/main/db/profiles';
import { loadModel, saveModel } from '../../src/main/model-store';
import { emptyLayout } from '../../src/shared/model/layout';
import { isEmptyDiff } from '../../src/shared/model/merge';
import { syncLayout } from '../../src/shared/model/arrange';

const BE = process.env.ERD_BE_DIR ?? 'C:/work/workspace/shop-be';
let skip = '';
try { passwordOf(getProfile(BE, 'dev'), BE); } catch (e) { skip = (e as Error).message; }
if (skip) console.warn(`dev DB 통합 시험을 건너뛴다: ${skip}`);

describe.skipIf(!!skip)('dev DB 리버스', () => {
  it('테이블 수, FK 수가 DB 직접 집계와 같고, 다시 리버스해도 ID 와 파일이 그대로다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-rev-'));

    const first = await reverse(BE, 'dev', dir);
    expect(first.hadModel).toBe(false);
    expect(first.model.tables.length).toBe(first.counts.tables);
    expect(first.model.tables.reduce((n, t) => n + t.fks.length, 0)).toBe(first.counts.fks);
    const layout = emptyLayout();
    syncLayout(first.model, layout);
    await saveModel(dir, first.model, layout);

    const loaded = await loadModel(dir);
    expect(loaded.errors).toEqual([]);

    const second = await reverse(BE, 'dev', dir);
    expect(second.hadModel).toBe(true);
    expect(isEmptyDiff(second.diff)).toBe(true);
    expect(second.model.tables.map(t => t.id)).toEqual(first.model.tables.map(t => t.id));
    const saved = await saveModel(dir, second.model, loaded.layout);
    expect(saved.written).toEqual([]);

    const files = fs.readdirSync(dir);
    const fnFiles = fs.readdirSync(path.join(dir, 'functions'));
    console.log(JSON.stringify({
      counts: first.counts, functions: first.model.functions.length, functionFiles: fnFiles.length, sequences: first.model.sequences.length,
      uniques: first.model.tables.reduce((n, t) => n + t.uniques.length, 0), indexes: first.model.tables.reduce((n, t) => n + t.indexes.length, 0),
      common: first.model.common.map(c => c.name), files, warnings: first.warnings,
    }));
  }, 60_000);
});
