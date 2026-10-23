import { ipcMain } from 'electron';
import { IPC, type ConnRef, type ManualConn } from '../../shared/ipc';
import { listManual, removeManual, saveManual } from '../db/manual';
import { forgetPassword, hasSavedPassword } from '../db/passwords';
import { profileKey } from '../db/connect';
import { readDb, reverse, testConnection, testDraft } from '../db/reverse';
import { loadCatalog } from '../db/catalog';
import { listProfiles, toInfo } from '../db/profiles';
import { getSettings } from '../settings';

export function registerConnectionsIpc() {
  ipcMain.handle(IPC.connList, (_e, beDir: string) => listProfiles(beDir).map(p => ({ ...toInfo(p), savedPassword: hasSavedPassword(profileKey(beDir, p.name)) })));
  ipcMain.handle(IPC.connForgetPassword, (_e, beDir: string, name: string) => forgetPassword(profileKey(beDir, name)));
  ipcMain.handle(IPC.connTest, (_e, ref: ConnRef) => testConnection(ref));
  ipcMain.handle(IPC.connTestDraft, (_e, conn: ManualConn, password: string) => testDraft(conn, password));
  ipcMain.handle(IPC.manualList, () => listManual());
  ipcMain.handle(IPC.manualSave, (_e, conn: ManualConn, password?: string) => saveManual(conn, password));
  ipcMain.handle(IPC.manualRemove, (_e, id: string) => removeManual(id));
  ipcMain.handle(IPC.dbCatalog, (_e, ref: ConnRef) => loadCatalog(ref));
  ipcMain.handle(IPC.dbRead, (_e, ref: ConnRef) => readDb(ref));
  ipcMain.handle(IPC.dbReverse, (_e, ref: ConnRef, modelDir: string) => {
    const s = getSettings();
    return reverse(ref, modelDir, { file: s.groupRulesFile, prefixes: s.groupPrefixes });
  });
}
