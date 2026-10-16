// 렌더러에 ErdApi 함수만 연다. ipcRenderer 자체는 열지 않는다 (Electron 보안 권고)
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ErdApi } from '../shared/ipc';

const api: ErdApi = {
  pickFolder: defaultPath => ipcRenderer.invoke(IPC.pickFolder, defaultPath),
  pickFile: defaultPath => ipcRenderer.invoke(IPC.pickFile, defaultPath),
  export: {
    nextVersion: dir => ipcRenderer.invoke(IPC.exportNextVersion, dir),
    write: (dir, files, history, opts) => ipcRenderer.invoke(IPC.exportWrite, dir, files, history, opts),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: patch => ipcRenderer.invoke(IPC.settingsSet, patch),
  },
  model: {
    load: dir => ipcRenderer.invoke(IPC.modelLoad, dir),
    save: (dir, model, layout) => ipcRenderer.invoke(IPC.modelSave, dir, model, layout),
  },
  conn: {
    list: beDir => ipcRenderer.invoke(IPC.connList, beDir),
    test: ref => ipcRenderer.invoke(IPC.connTest, ref),
    testDraft: (conn, password) => ipcRenderer.invoke(IPC.connTestDraft, conn, password),
  },
  manual: {
    list: () => ipcRenderer.invoke(IPC.manualList),
    save: (conn, password) => ipcRenderer.invoke(IPC.manualSave, conn, password),
    remove: id => ipcRenderer.invoke(IPC.manualRemove, id),
  },
  db: {
    reverse: (ref, modelDir) => ipcRenderer.invoke(IPC.dbReverse, ref, modelDir),
    catalog: ref => ipcRenderer.invoke(IPC.dbCatalog, ref),
    read: ref => ipcRenderer.invoke(IPC.dbRead, ref),
  },
  sql: {
    open: (tabId, ref, label) => ipcRenderer.invoke(IPC.sqlOpen, tabId, ref, label),
    run: (tabId, sql) => ipcRenderer.invoke(IPC.sqlRun, tabId, sql),
    fetchMore: tabId => ipcRenderer.invoke(IPC.sqlFetchMore, tabId),
    commit: tabId => ipcRenderer.invoke(IPC.sqlCommit, tabId),
    rollback: tabId => ipcRenderer.invoke(IPC.sqlRollback, tabId),
    allowWrite: tabId => ipcRenderer.invoke(IPC.sqlAllowWrite, tabId),
    close: tabId => ipcRenderer.invoke(IPC.sqlClose, tabId),
  },
  history: {
    list: key => ipcRenderer.invoke(IPC.historyList, key),
  },
  term: {
    spawn: (id, shell, cols, rows) => ipcRenderer.invoke(IPC.termSpawn, id, shell, cols, rows),
    input: (id, data) => ipcRenderer.send(IPC.termInput, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.termResize, id, cols, rows),
    kill: id => ipcRenderer.send(IPC.termKill, id),
    onData: cb => { ipcRenderer.on(IPC.termData, (_e, id, d) => cb(id, d)); },
    onExit: cb => { ipcRenderer.on(IPC.termExit, (_e, id, c) => cb(id, c)); },
  },
  onCloseRequest: cb => { ipcRenderer.on(IPC.closeRequest, (_e, dirty) => cb(dirty)); },
  confirmClose: ok => ipcRenderer.send(IPC.closeConfirm, ok),
  mcp: {
    info: () => ipcRenderer.invoke(IPC.mcpInfo),
    onCall: cb => { ipcRenderer.on(IPC.mcpCall, (_e, id, tool, args) => cb(id, tool, args)); },
    reply: (id, r) => ipcRenderer.send(IPC.mcpReply, id, r),
  },
};

contextBridge.exposeInMainWorld('erd', api);
