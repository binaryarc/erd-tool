import { describe, expect, it, vi } from 'vitest';

// node-pty 는 Electron 용 네이티브 모듈이라 셸 찾기 시험에서는 불러오지 않는다
vi.mock('node-pty', () => ({}));
const { findShell } = await import('../../src/main/terminal');

const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  PATH: 'C:\\Windows\\System32;C:\\tools\\bin' };
const has = (...paths: string[]) => (p: string) => paths.map(x => x.toLowerCase()).includes(p.toLowerCase());

describe('셸 찾기', () => {
  it('PowerShell 7 이 있으면 7 을 쓴다', () => {
    const s = findShell('powershell', env, has('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
    expect([s.label, s.path]).toEqual(['PowerShell 7', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']);
  });

  it('PowerShell 7 이 없으면 Windows PowerShell 5.1 을 쓴다', () => {
    const s = findShell('powershell', env, has('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
    expect(s.label).toBe('Windows PowerShell 5.1');
  });

  it('PATH 에만 있는 pwsh 도 찾는다', () => {
    expect(findShell('powershell', env, has('C:\\tools\\bin\\pwsh.exe')).path).toBe('C:\\tools\\bin\\pwsh.exe');
  });

  it('Git Bash 는 사용자 단위 설치도 찾고, System32 의 WSL bash 는 잡지 않는다', () => {
    expect(findShell('bash', env, has('C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')).path)
      .toBe('C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
    expect(() => findShell('bash', env, has('C:\\Windows\\System32\\bash.exe'))).toThrow('Git Bash 를 찾지 못했습니다');
  });
});
