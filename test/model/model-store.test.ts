import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModel, saveModel } from '../../src/main/model-store';
import { emptyLayout } from '../../src/shared/model/layout';
import type { SchemaModel } from '../../src/shared/model/types';
import { SHOP_GROUPS } from '../helpers/fixtures';

const model = (names: string[]): SchemaModel => ({
  version: 1, groups: SHOP_GROUPS, common: [], sequences: [], functions: [],
  tables: names.map((name, i) => ({ id: 't' + (i + 1), name, comment: '', columns: [{ name: 'seq', type: 'integer', notNull: true }], pk: ['seq'], fks: [], uniques: [], indexes: [] })),
});

describe('모델 폴더 저장', () => {
  it('두 번째 저장은 아무 파일도 다시 쓰지 않고, 읽은 모델이 같다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-'));
    const m = model(['mst_biz', 'whs_iw_h']);
    const first = await saveModel(dir, m, emptyLayout());
    expect(first.written).toEqual(['_index.erd', 'layout.json', 'mdm.erd', 'wms.erd']);
    const loaded = await loadModel(dir);
    expect(loaded.errors).toEqual([]);
    const second = await saveModel(dir, loaded.model, loaded.layout);
    expect(second.written).toEqual([]);
    expect(second.unchanged.length).toBe(4);
  });

  it('테이블이 없어진 그룹 파일은 지운다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-'));
    await saveModel(dir, model(['mst_biz', 'whs_iw_h']), emptyLayout());
    const r = await saveModel(dir, model(['mst_biz']), emptyLayout());
    expect(r.removed).toEqual(['wms.erd']);
    expect(fs.existsSync(path.join(dir, 'wms.erd'))).toBe(false);
  });
});
