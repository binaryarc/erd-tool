// 내장 터미널 (설계 11장): node-pty 로 PowerShell 또는 Git Bash 를 띄운다. 셸 실행은 메인만 한다.
// - PowerShell 은 7(pwsh) 이 없으면 Windows 에 기본으로 들어 있는 5.1(powershell.exe) 을 쓴다
// - Git Bash 는 System32 의 bash.exe(WSL) 를 잡지 않는다
// - 시작 폴더는 사용자 홈 (사용자 지정 2026-10-15)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import type { ShellKind } from '../shared/ipc';

export interface ShellFound { path: string; label: string; args: string[] }

function candidates(kind: ShellKind, env: NodeJS.ProcessEnv): ShellFound[] {
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const sysRoot = env.SystemRoot ?? 'C:\\Windows';
  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  if (kind === 'powershell') {
    const ps7 = { label: 'PowerShell 7', args: ['-NoLogo'] };
    const ps5 = { label: 'Windows PowerShell 5.1', args: ['-NoLogo'] };
    return [
      { ...ps7, path: path.join(pf, 'PowerShell', '7', 'pwsh.exe') },
      { ...ps7, path: 'pwsh.exe' },
      { ...ps5, path: path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') },
      { ...ps5, path: 'powershell.exe' },
    ];
  }
  const git = { label: 'Git Bash', args: ['--login', '-i'] };
  return [
    { ...git, path: path.join(pf, 'Git', 'bin', 'bash.exe') },
    { ...git, path: path.join(local, 'Programs', 'Git', 'bin', 'bash.exe') }, // 사용자 단위 설치
    { ...git, path: 'bash.exe' },
  ];
}

/** 경로가 없는 이름(pwsh.exe 등)은 PATH 에서 찾는다. bash 는 System32(WSL 의 bash.exe) 를 건너뛴다 */
export function findShell(kind: ShellKind, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): ShellFound {
  const sys32 = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32').toLowerCase();
  for (const c of candidates(kind, env)) {
    if (/[\\/]/.test(c.path)) {
      if (exists(c.path)) return c;
      continue;
    }
    for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
      if (!dir) continue;
      if (kind === 'bash' && path.normalize(dir).toLowerCase().replace(/[\\/]+$/, '') === sys32) continue;
      const p = path.join(dir, c.path);
      if (exists(p)) return { ...c, path: p };
    }
  }
  throw new Error(kind === 'powershell' ? 'PowerShell 을 찾지 못했다' : 'Git Bash 를 찾지 못했다. Git for Windows 를 설치하세요');
}

const terms = new Map<string, pty.IPty>();

/** 터미널 셸에 더 넣는 환경변수 (STEP 8: ERD_MCP_URL, ERD_MCP_TOKEN. 설계 11장 3번) */
let extraEnv: Record<string, string> = {};
export const setTermEnv = (env: Record<string, string>) => { extraEnv = env; };

export function spawnTerm(id: string, kind: ShellKind, cols: number, rows: number,
  onData: (d: string) => void, onExit: (code: number) => void) {
  killTerm(id);
  const shell = findShell(kind);
  const cwd = os.homedir();
  // useConptyDll: 기본 방식은 셸을 끌 때 node-pty 보조 프로세스가 「AttachConsole failed」 를 내고 5초 늦게 정리된다 (STEP 4 확인)
  const p = pty.spawn(shell.path, shell.args, {
    name: 'xterm-256color', cols, rows, cwd, env: { ...(process.env as Record<string, string>), ...extraEnv }, useConptyDll: true,
  });
  p.onData(onData);
  p.onExit(({ exitCode }) => { terms.delete(id); onExit(exitCode); });
  terms.set(id, p);
  return { shell: shell.path, label: shell.label, cwd };
}

export const inputTerm = (id: string, data: string) => terms.get(id)?.write(data);
export const resizeTerm = (id: string, cols: number, rows: number) => terms.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 2));

export function killTerm(id: string) {
  const p = terms.get(id);
  terms.delete(id);
  try { p?.kill(); } catch { /* 이미 종료 */ }
}
