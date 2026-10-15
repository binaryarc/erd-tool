// 렌더러에 ErdApi 함수만 연다. ipcRenderer 자체는 열지 않는다 (Electron 보안 권고)
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ErdApi } from '../shared/ipc';

const api: ErdApi = {
  pickFolder: defaultPath => ipcRenderer.invoke(IPC.pickFolder, defaultPath),
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
    test: (beDir, profile) => ipcRenderer.invoke(IPC.connTest, beDir, profile),
  },
  db: {
    reverse: (beDir, profile, modelDir) => ipcRenderer.invoke(IPC.dbReverse, beDir, profile, modelDir),
  },
};

contextBridge.exposeInMainWorld('erd', api);
