import { ipcMain } from 'electron';
import { IPC, type ConnRef } from '../../shared/ipc';
import { allowWrite, closeSession, commitTx, fetchMore, openSession, rollbackTx, runSql } from '../db/session';
import { addHistory, listHistory } from '../history';

// SQL 탭 (설계 5장). 성공한 문장은 리터럴을 지워 이력에 남긴다
export function registerSqlIpc() {
  ipcMain.handle(IPC.sqlOpen, (_e, tabId: string, ref: ConnRef, label: string) => openSession(tabId, ref, label));
  ipcMain.handle(IPC.sqlRun, async (_e, tabId: string, sql: string) => {
    const r = await runSql(tabId, sql);
    if (!r.error) addHistory(r.state.connKey, sql);
    return r;
  });
  ipcMain.handle(IPC.sqlFetchMore, (_e, tabId: string) => fetchMore(tabId));
  ipcMain.handle(IPC.sqlCommit, (_e, tabId: string) => commitTx(tabId));
  ipcMain.handle(IPC.sqlRollback, (_e, tabId: string) => rollbackTx(tabId));
  ipcMain.handle(IPC.sqlAllowWrite, (_e, tabId: string) => allowWrite(tabId));
  ipcMain.handle(IPC.sqlClose, (_e, tabId: string) => closeSession(tabId));
  ipcMain.handle(IPC.historyList, (_e, key: string) => listHistory(key));
}
