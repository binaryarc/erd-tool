import { ipcMain } from 'electron';
import { API, type ConnRef, type ManualConn } from '../../shared/ipc';
import { listManual, removeManual, saveManual } from '../db/manual';
import { forgetPassword, hasSavedPassword } from '../db/passwords';
import { profileKey } from '../db/connect';
import { readDb, reverse, testConnection, testDraft } from '../db/reverse';
import { loadCatalog } from '../db/catalog';
import { listProfiles, toInfo } from '../db/profiles';
import { getSettings } from '../settings';

export function registerConnectionsIpc() {
  ipcMain.handle(API.conn.list.channel, (_e, beDir: string) => listProfiles(beDir).map(p => ({ ...toInfo(p), savedPassword: hasSavedPassword(profileKey(beDir, p.name)) })));
  ipcMain.handle(API.conn.forgetPassword.channel, (_e, beDir: string, name: string) => forgetPassword(profileKey(beDir, name)));
  ipcMain.handle(API.conn.test.channel, (_e, ref: ConnRef) => testConnection(ref));
  ipcMain.handle(API.conn.testDraft.channel, (_e, conn: ManualConn, password: string) => testDraft(conn, password));
  ipcMain.handle(API.manual.list.channel, () => listManual());
  ipcMain.handle(API.manual.save.channel, (_e, conn: ManualConn, password?: string) => saveManual(conn, password));
  ipcMain.handle(API.manual.remove.channel, (_e, id: string) => removeManual(id));
  ipcMain.handle(API.db.catalog.channel, (_e, ref: ConnRef) => loadCatalog(ref));
  ipcMain.handle(API.db.read.channel, (_e, ref: ConnRef) => readDb(ref));
  ipcMain.handle(API.db.reverse.channel, (_e, ref: ConnRef, modelDir: string) => {
    const s = getSettings();
    return reverse(ref, modelDir, { file: s.groupRulesFile, prefixes: s.groupPrefixes });
  });
}
