import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findFlywayDir, nextFlywayVersion, readTemplates, writeExport } from '../../src/main/export';

let dir = '';
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'erd-export-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const HISTORY = '# 이력\n\n## 변경 이력\n\n| 반영일시 | 내용 |\n|---|---|\n| 1 | a |\n';

describe('내보내기 파일 쓰기', () => {
  it('다음 Flyway 번호 (없는 폴더는 1)', async () => {
    await fs.writeFile(path.join(dir, 'V7__a.sql'), '');
    await fs.writeFile(path.join(dir, 'R__b.sql'), '');
    expect(await nextFlywayVersion(dir)).toBe(8);
    expect(await nextFlywayVersion(path.join(dir, 'none'))).toBe(1);
  });

  it('새 파일을 쓰고 이력 표에 한 줄 덧붙인다', async () => {
    const hist = path.join(dir, 'migration-history.md');
    await fs.writeFile(hist, HISTORY);
    const r = await writeExport(path.join(dir, 'out'), [{ name: 'a.md', content: 'A\n' }], { file: hist, cells: ['2', 'b'] });
    expect(r.written).toEqual([path.join(dir, 'out', 'a.md')]);
    expect(r.replaced).toEqual([]);
    expect(await fs.readFile(r.written[0], 'utf8')).toBe('A\n');
    expect(await fs.readFile(hist, 'utf8')).toBe(HISTORY.replace('| 1 | a |\n', '| 1 | a |\n| 2 | b |\n'));
  });

  it('같은 이름이 하나라도 있으면 아무것도 쓰지 않는다, 폴더가 든 이름도 거부', async () => {
    await fs.writeFile(path.join(dir, 'b.md'), 'old');
    await expect(writeExport(dir, [{ name: 'a.md', content: 'A' }, { name: 'b.md', content: 'B' }])).rejects.toThrow('b.md');
    expect(await fs.readdir(dir)).toEqual(['b.md']);
    expect(await fs.readFile(path.join(dir, 'b.md'), 'utf8')).toBe('old');
    await expect(writeExport(dir, [{ name: '../x.md', content: '' }])).rejects.toThrow('폴더');
  });

  it('overwrite 면 같은 이름을 덮어쓰고 덮어쓴 이름을 알려준다 (MD)', async () => {
    await fs.writeFile(path.join(dir, 'b.md'), 'old');
    const r = await writeExport(dir, [{ name: 'a.md', content: 'A' }, { name: 'b.md', content: 'B' }], undefined, { overwrite: true });
    expect(r.replaced).toEqual(['b.md']);
    expect(await fs.readFile(path.join(dir, 'b.md'), 'utf8')).toBe('B');
  });

  it('이력 파일에 표가 없으면 새 파일도 쓰지 않는다', async () => {
    const hist = path.join(dir, 'h.md');
    await fs.writeFile(hist, '# 없음\n');
    await expect(writeExport(dir, [{ name: 'a.md', content: 'A' }], { file: hist, cells: ['x'] })).rejects.toThrow('표가 없습니다');
    expect(await fs.readdir(dir)).toEqual(['h.md']);
  });
});

describe('Flyway 폴더 기본값', () => {
  it('src/main 아래 실제로 있는 db/migration 을 고르고, 표준 resources 가 먼저, 없으면 null', async () => {
    expect(await findFlywayDir(dir)).toBeNull();
    await fs.mkdir(path.join(dir, 'src/main/conf/db/migration'), { recursive: true });
    expect(await findFlywayDir(dir)).toBe(path.join(dir, 'src/main/conf/db/migration'));
    await fs.mkdir(path.join(dir, 'src/main/resources/db/migration'), { recursive: true });
    expect(await findFlywayDir(dir)).toBe(path.join(dir, 'src/main/resources/db/migration'));
  });
});

describe('MD 템플릿 폴더 읽기', () => {
  it('내장 템플릿과 이름이 같은 파일만 읽고, 폴더가 없으면 오류', async () => {
    await fs.writeFile(path.join(dir, 'group-tables.md'), 'G');
    await fs.writeFile(path.join(dir, 'other.md'), 'X');
    expect(await readTemplates(dir)).toEqual({ 'group-tables.md': 'G' });
    await expect(readTemplates(path.join(dir, 'none'))).rejects.toThrow('템플릿 폴더가 없습니다');
  });
});
