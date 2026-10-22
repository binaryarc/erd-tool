// BE 레포 안에서 설정 파일 폴더, Flyway 폴더를 찾는다 (2026-10-22).
// Spring 표준 위치(src/main/resources)를 먼저 보고, 없으면 src/main 아래 다른 폴더를 얕게 훑는다(소스 폴더 java, kotlin 등은 뺀다).
// 프로젝트마다 다른 폴더 이름(resource, prop 등)을 코드에 정해 두지 않으려는 것이다.

import fs from 'node:fs';
import path from 'node:path';

const SOURCE_DIRS = new Set(['java', 'kotlin', 'groovy', 'scala']);

/** beDir/src/main 아래 폴더들. 표준 위치 src/main/resources 와 그 아래가 먼저, 나머지는 얕은 것부터 이름순 (깊이 maxDepth 까지) */
export function mainDirs(beDir: string, maxDepth = 3): string[] {
  const root = path.join(beDir, 'src', 'main');
  const found: string[] = [];
  let level = [root];
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries.filter(x => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        if (depth === 0 && SOURCE_DIRS.has(e.name)) continue;
        next.push(path.join(dir, e.name));
      }
    }
    found.push(...next);
    level = next;
  }
  const std = path.join(root, 'resources');
  const isStd = (p: string) => p === std || p.startsWith(std + path.sep);
  return [...found.filter(isStd), ...found.filter(p => !isStd(p))];
}
