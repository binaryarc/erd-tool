import { ipcMain } from 'electron';
import { API, type ConnRef } from '../../shared/ipc';
import { allowWrite, closeSession, commitTx, fetchMore, openSession, rollbackTx, runSql } from '../db/session';
import { addHistory, listHistory } from '../history';

// SQL 탭 (설계 5장). 성공한 문장은 리터럴을 지워 이력에 남긴다
export function registerSqlIpc() {
  ipcMain.handle(API.sql.open.channel, (_e, tabId: string, ref: ConnRef, label: string) => openSession(tabId, ref, label));
  ipcMain.handle(API.sql.run.channel, async (_e, tabId: string, sql: string) => {
    const r = await runSql(tabId, sql);
    if (!r.error) addHistory(r.state.connKey, sql);
    return r;
  });
  ipcMain.handle(API.sql.fetchMore.channel, (_e, tabId: string) => fetchMore(tabId));
  ipcMain.handle(API.sql.commit.channel, (_e, tabId: string) => commitTx(tabId));
  ipcMain.handle(API.sql.rollback.channel, (_e, tabId: string) => rollbackTx(tabId));
  ipcMain.handle(API.sql.allowWrite.channel, (_e, tabId: string) => allowWrite(tabId));
  ipcMain.handle(API.sql.close.channel, (_e, tabId: string) => closeSession(tabId));
  ipcMain.handle(API.history.list.channel, (_e, key: string) => listHistory(key));
}
