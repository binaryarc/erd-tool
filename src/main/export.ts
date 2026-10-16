// 내보내기 파일 쓰기 (STEP 7, 메인 프로세스 전용). MD, Flyway 내용은 화면(shared/export)이 만들고 여기서는 쓰기만 한다.
// 새 파일만 쓴다: 같은 이름이 하나라도 있으면 아무것도 쓰지 않고 거부한다(사용자 지정: 기존 파일을 덮지 않는다).
// 예외는 99-migration-history.md 「변경 이력」 표에 한 줄 덧붙이기 하나뿐이다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { appendHistoryLine, nextVersion } from '../shared/export/flyway';
import type { ExportFile, ExportResult, HistoryAppend } from '../shared/ipc';

export async function nextFlywayVersion(dir: string): Promise<number> {
  return nextVersion(await fs.readdir(dir).catch(() => [] as string[]));
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

export async function writeExport(dir: string, files: ExportFile[], history?: HistoryAppend): Promise<ExportResult> {
  for (const f of files) {
    if (!f.name || f.name !== path.basename(f.name)) throw new Error(`파일 이름에 폴더가 들어 있다: ${f.name}`);
  }
  const taken = [];
  for (const f of files) if (await exists(path.join(dir, f.name))) taken.push(f.name);
  if (taken.length) throw new Error(`같은 이름 파일이 있어 쓰지 않았다: ${taken.join(', ')}`);
  // 이력 파일을 먼저 읽고 고쳐 본다. 표를 못 찾으면 새 파일도 쓰지 않는다
  const historyText = history ? appendHistoryLine(await fs.readFile(history.file, 'utf8'), history.line) : undefined;

  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const f of files) {
    const p = path.join(dir, f.name);
    await fs.writeFile(p, f.content, { encoding: 'utf8', flag: 'wx' }); // wx: 그 사이에 생긴 파일도 덮지 않는다
    written.push(p);
  }
  if (history && historyText !== undefined) await fs.writeFile(history.file, historyText, 'utf8');
  return { written, history: history?.file };
}
