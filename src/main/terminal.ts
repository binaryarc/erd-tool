// 내장 터미널 (설계 11장): node-pty 로 PowerShell 7 또는 Git Bash 를 띄운다. 셸 실행은 메인만 한다.
// STEP 1 시험(spikes/pty)을 옮겼다. 교훈: Git Bash 에서 띄우면 PATH 에 pwsh.exe 가 없어 설치 경로도 찾는다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import type { ShellKind } from '../shared/ipc';

const CANDIDATES: Record<ShellKind, string[]> = {
  pwsh: ['C:/Program Files/PowerShell/7/pwsh.exe', 'pwsh.exe'],
  bash: ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe', 'bash.exe'],
};
const ARGS: Record<ShellKind, string[]> = { pwsh: ['-NoLogo'], bash: ['--login', '-i'] };

function findOnPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

export function findShell(kind: ShellKind): string {
  for (const c of CANDIDATES[kind]) {
    const p = c.includes('/') ? (fs.existsSync(c) ? c : null) : findOnPath(c);
    if (p) return p;
  }
  throw new Error(`${kind === 'pwsh' ? 'PowerShell 7' : 'Git Bash'} 을 찾지 못했다`);
}

/** 시작 폴더: BE 폴더 옆 허브(docs-hub), 없으면 사용자 홈 */
export function startDir(beDir?: string): string {
  const hub = beDir ? path.join(path.dirname(beDir), 'docs-hub') : '';
  return hub && fs.existsSync(hub) ? hub : os.homedir();
}

const terms = new Map<string, pty.IPty>();

export function spawnTerm(id: string, kind: ShellKind, cols: number, rows: number, beDir: string | undefined,
  onData: (d: string) => void, onExit: (code: number) => void) {
  killTerm(id);
  const shell = findShell(kind);
  const cwd = startDir(beDir);
  const p = pty.spawn(shell, ARGS[kind], { name: 'xterm-256color', cols, rows, cwd, env: process.env as Record<string, string>, useConptyDll: true });
  p.onData(onData);
  p.onExit(({ exitCode }) => { terms.delete(id); onExit(exitCode); });
  terms.set(id, p);
  return { shell, cwd };
}

export const inputTerm = (id: string, data: string) => terms.get(id)?.write(data);
export const resizeTerm = (id: string, cols: number, rows: number) => terms.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 2));

export function killTerm(id: string) {
  const p = terms.get(id);
  terms.delete(id);
  // STEP 1 에서 종료 때 conpty 콘솔 목록 조회 오류가 났다. 이미 끝난 셸에 kill 을 다시 보내지 않고, 오류는 삼킨다
  try { p?.kill(); } catch { /* 이미 종료 */ }
}

