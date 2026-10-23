import { ipcMain } from 'electron';
import { API } from '../../shared/ipc';
import { findFlywayDir, nextFlywayVersion, readTemplates, writeExport } from '../export';

export function registerExportIpc() {
  ipcMain.handle(API.export.nextVersion.channel, (_e, dir: string) => nextFlywayVersion(dir));
  ipcMain.handle(API.export.flywayDir.channel, (_e, beDir: string) => findFlywayDir(beDir));
  ipcMain.handle(API.export.templates.channel, (_e, dir: string) => readTemplates(dir));
  ipcMain.handle(API.export.write.channel, (_e, dir: string, files, history, opts) => writeExport(dir, files, history, opts));
}
