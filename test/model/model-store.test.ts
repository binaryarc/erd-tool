import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadModel, modelDirOfFile, planSave, saveModel } from '../../src/main/model-store';
import { emptyLayout } from '../../src/shared/model/layout';
import type { SchemaModel } from '../../src/shared/model/types';
import { SAMPLE_GROUPS } from '../helpers/fixtures';

const model = (names: string[]): SchemaModel => ({
  version: 1, groups: SAMPLE_GROUPS, common: [], sequences: [], functions: [],
  tables: names.map((name, i) => ({ id: 't' + (i + 1), name, comment: '', columns: [{ name: 'seq', type: 'integer', notNull: true }], pk: ['seq'], fks: [], uniques: [], indexes: [] })),
});

describe('모델 폴더 저장', () => {
  it('두 번째 저장은 아무 파일도 다시 쓰지 않고, 읽은 모델이 같다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-'));
    const m = model(['mst_brand', 'whs_in_h']);
    const first = await saveModel(dir, m, emptyLayout());
    expect(first.written).toEqual(['_index.erd', 'layout.json', 'tables.erd']);
    const loaded = await loadModel(dir);
    expect(loaded.errors).toEqual([]);
    const second = await saveModel(dir, loaded.model, loaded.layout);
    expect(second.written).toEqual([]);
    expect(second.unchanged.length).toBe(3);
  });

  it('예전처럼 접두어 그룹마다 나뉜 폴더를 저장하면 tables.erd 로 모으고 그룹 파일은 지운다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-'));
    fs.writeFileSync(path.join(dir, '_index.erd'), 'erd-model 2\ndb postgresql public\ngroup mst prefix=mst_ default\ngroup whs prefix=whs_\n');
    fs.writeFileSync(path.join(dir, 'mst.erd'), 'mst_brand @t1\n  seq integer PK\n');
    fs.writeFileSync(path.join(dir, 'whs.erd'), 'whs_in_h @t2\n  seq integer PK\n');
    const loaded = await loadModel(dir);
    expect(loaded.model.tables.map(t => t.name)).toEqual(['mst_brand', 'whs_in_h']);
    const r = await saveModel(dir, loaded.model, loaded.layout);
    expect(r.removed).toEqual(['mst.erd', 'whs.erd']);
    expect(fs.readdirSync(dir).sort()).toEqual(['_index.erd', 'layout.json', 'tables.erd']);
  });

  it('폴더 열기에서 고른 파일로 모델 폴더를 정한다: 그 폴더, functions 안 파일이면 그 위, _index.erd 가 없으면 모델 아님', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-'));
    await saveModel(dir, { ...model(['mst_brand']), functions: [{ name: 'fn_a', args: '', definition: 'select 1' }] }, emptyLayout());
    expect(modelDirOfFile(path.join(dir, 'layout.json'))).toEqual({ dir, hasModel: true });
    expect(modelDirOfFile(path.join(dir, 'functions', 'fn_a.sql'))).toEqual({ dir, hasModel: true });
    expect(modelDirOfFile(path.join(os.tmpdir(), 'x.txt')).hasModel).toBe(false);
  });

  it('저장 미리보기는 파일을 쓰지 않고 새로 생길, 바뀔, 그대로, 지울 파일을 나눠 알려 준다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-'));
    expect(await planSave(dir, model(['mst_brand']), emptyLayout())).toMatchObject({ added: ['_index.erd', 'layout.json', 'tables.erd'], changed: [], unchanged: [], removed: [] });
    expect(fs.readdirSync(dir)).toEqual([]); // 미리보기는 쓰지 않는다
    await saveModel(dir, model(['mst_brand']), emptyLayout());
    fs.writeFileSync(path.join(dir, 'old.erd'), 'x @t9\n  seq integer PK\n');
    const plan = await planSave(dir, model(['mst_brand', 'whs_in_h']), emptyLayout());
    expect(plan).toMatchObject({ added: [], changed: ['tables.erd'], unchanged: ['_index.erd', 'layout.json'], removed: ['old.erd'] });
  });
});

describe('모델 폴더 원자적 저장', () => {
  it('쓰는 도중 오류가 나면 원래 파일이 원래 내용 그대로 남고 .tmp 도 남지 않는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-'));
    await saveModel(dir, model(['mst_brand']), emptyLayout());
    const before = fs.readFileSync(path.join(dir, 'tables.erd'), 'utf8');
    const real = fsp.writeFile;
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opt) => {
      await real(file, String(data).slice(0, 10), opt as BufferEncoding); // 반쪽만 쓰고 죽은 것처럼
      throw new Error('디스크 가득 참');
    });
    try {
      await expect(saveModel(dir, model(['mst_brand', 'whs_in_h']), emptyLayout())).rejects.toThrow('디스크 가득 참');
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(dir, 'tables.erd'), 'utf8')).toBe(before);
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('저장을 마친 뒤 폴더에 .tmp 파일이 남지 않는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-'));
    await saveModel(dir, { ...model(['mst_brand']), functions: [{ name: 'fn_a', args: '', definition: 'select 1' }] }, emptyLayout());
    await saveModel(dir, model(['mst_brand', 'whs_in_h']), emptyLayout());
    const all = [...fs.readdirSync(dir), ...fs.readdirSync(path.join(dir, 'functions'))];
    expect(all.filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});
