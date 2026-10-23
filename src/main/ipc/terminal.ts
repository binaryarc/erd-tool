import { ipcMain, type BrowserWindow } from 'electron';
import { IPC, type ShellKind } from '../../shared/ipc';
import { inputTerm, killTerm, resizeTerm, spawnTerm } from '../terminal';

// 터미널 (설계 11장)
export function registerTerminalIpc(win: BrowserWindow) {
  ipcMain.handle(IPC.termSpawn, (_e, id: string, kind: ShellKind, cols: number, rows: number) =>
    spawnTerm(id, kind, cols, rows,
      d => !win.isDestroyed() && win.webContents.send(IPC.termData, id, d),
      c => !win.isDestroyed() && win.webContents.send(IPC.termExit, id, c)));
  ipcMain.on(IPC.termInput, (_e, id: string, d: string) => inputTerm(id, d));
  ipcMain.on(IPC.termResize, (_e, id: string, c: number, r: number) => resizeTerm(id, c, r));
  ipcMain.on(IPC.termKill, (_e, id: string) => killTerm(id));
}
