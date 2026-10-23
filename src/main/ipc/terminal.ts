import { ipcMain, type BrowserWindow } from 'electron';
import { API, type ShellKind } from '../../shared/ipc';
import { inputTerm, killTerm, resizeTerm, spawnTerm } from '../terminal';

// 터미널 (설계 11장)
export function registerTerminalIpc(win: BrowserWindow) {
  ipcMain.handle(API.term.spawn.channel, (_e, id: string, kind: ShellKind, cols: number, rows: number) =>
    spawnTerm(id, kind, cols, rows,
      d => !win.isDestroyed() && win.webContents.send(API.term.onData.channel, id, d),
      c => !win.isDestroyed() && win.webContents.send(API.term.onExit.channel, id, c)));
  ipcMain.on(API.term.input.channel, (_e, id: string, d: string) => inputTerm(id, d));
  ipcMain.on(API.term.resize.channel, (_e, id: string, c: number, r: number) => resizeTerm(id, c, r));
  ipcMain.on(API.term.kill.channel, (_e, id: string) => killTerm(id));
}
