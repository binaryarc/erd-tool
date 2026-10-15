// 렌더러에 ErdApi 함수만 연다. ipcRenderer 자체는 열지 않는다 (Electron 보안 권고)
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ErdApi } from '../shared/ipc';

const api: ErdApi = {
  model: {
    pickFolder: () => ipcRenderer.invoke(IPC.modelPickFolder),
    load: dir => ipcRenderer.invoke(IPC.modelLoad, dir),
    save: (dir, model, layout) => ipcRenderer.invoke(IPC.modelSave, dir, model, layout),
  },
};

contextBridge.exposeInMainWorld('erd', api);
