import { dialog, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API } from '../../shared/ipc';
import { loadModel, modelDirOfFile, planSave, saveModel } from '../model-store';
import { getSettings } from '../settings';

export function registerFilesIpc(win: BrowserWindow) {
  ipcMain.handle(API.pickFolder.channel, async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  // 「ERD 저장」 폴더 (2026-10-16 사용자 지정): 처음 위치는 지금 모델 폴더(없으면 그 위 폴더), 둘 다 없으면 사용자 홈
  ipcMain.handle(API.model.pickSaveDir.channel, async () => {
    const md = getSettings().modelDir;
    const defaultPath = [md, md && path.dirname(md)].find(d => d && fs.existsSync(d)) || os.homedir();
    const r = await dialog.showOpenDialog(win, { title: 'ERD 모델을 저장할 폴더', defaultPath, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const hasModel = fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.erd'));
    return { dir, hasModel };
  });
  // 「ERD 폴더 열기」 (2026-10-16 사용자 지정): 폴더 안 파일이 모두 보이게 파일 창을 쓴다.
  // Windows 는 한 창에서 파일과 폴더를 함께 고를 수 없어(Electron 문서) 폴더 안 파일 하나를 고르면 그 폴더를 연다
  ipcMain.handle(API.model.pickOpen.channel, async (_e, defaultDir?: string) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'ERD 폴더 열기: 폴더 안의 파일을 하나 고르세요 (예: _index.erd)', defaultPath: defaultDir, buttonLabel: '이 폴더 열기',
      properties: ['openFile'], filters: [{ name: '모든 파일', extensions: ['*'] }, { name: 'ERD 모델', extensions: ['erd'] }],
    });
    return r.canceled || !r.filePaths[0] ? null : modelDirOfFile(r.filePaths[0]);
  });
  ipcMain.handle(API.model.planSave.channel, async (_e, dir: string, model, layout) => {
    const { out: _out, ...plan } = await planSave(dir, model, layout);
    return plan;
  });
  ipcMain.handle(API.pickFile.channel, async (_e, defaultPath?: string, kind: 'md' | 'json' = 'md') => {
    const filter = kind === 'json' ? { name: 'JSON', extensions: ['json'] } : { name: 'Markdown', extensions: ['md'] };
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openFile'], filters: [filter] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(API.model.load.channel, (_e, dir: string) => loadModel(dir));
  ipcMain.handle(API.model.save.channel, (_e, dir, model, layout) => saveModel(dir, model, layout));
}
