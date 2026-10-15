import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import { loadModel, saveModel } from './model-store';

function registerIpc(win: BrowserWindow) {
  ipcMain.handle(IPC.modelPickFolder, async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.modelLoad, (_e, dir: string) => loadModel(dir));
  ipcMain.handle(IPC.modelSave, (_e, dir, model, layout) => saveModel(dir, model, layout));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'ERD 도구',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  registerIpc(win);

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 시험 모드: ERD_AUTO_DIR 의 모델을 화면에서 열고, 화면 글자를 출력한 뒤 종료한다
  const autoDir = process.env.ERD_AUTO_DIR;
  if (autoDir) {
    win.webContents.once('did-finish-load', async () => {
      const text = await win.webContents.executeJavaScript(
        `window.__erdOpen(${JSON.stringify(autoDir)}).then(() => document.body.innerText)`);
      console.log('[auto]', text.replace(/\s+/g, ' ').slice(0, 300));
      app.quit();
    });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
