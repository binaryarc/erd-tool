import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc';
import { findFlywayDir, nextFlywayVersion, readTemplates, writeExport } from '../export';

export function registerExportIpc() {
  ipcMain.handle(IPC.exportNextVersion, (_e, dir: string) => nextFlywayVersion(dir));
  ipcMain.handle(IPC.exportFlywayDir, (_e, beDir: string) => findFlywayDir(beDir));
  ipcMain.handle(IPC.exportTemplates, (_e, dir: string) => readTemplates(dir));
  ipcMain.handle(IPC.exportWrite, (_e, dir: string, files, history, opts) => writeExport(dir, files, history, opts));
}
