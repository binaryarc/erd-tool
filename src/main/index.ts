import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC, type ConnRef, type ManualConn } from '../shared/ipc';
import { forgetSessionPasswords, listManual, removeManual, saveManual } from './db/manual';
import { reverse, testConnection, testDraft } from './db/reverse';
import { getProfile, listProfiles, passwordOf, toInfo } from './db/profiles';
import { loadModel, saveModel } from './model-store';
import { getSettings, setSettings } from './settings';

function registerIpc(win: BrowserWindow) {
  ipcMain.handle(IPC.pickFolder, async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch) => setSettings(patch));
  ipcMain.handle(IPC.modelLoad, (_e, dir: string) => loadModel(dir));
  ipcMain.handle(IPC.modelSave, (_e, dir, model, layout) => saveModel(dir, model, layout));
  ipcMain.handle(IPC.connList, (_e, beDir: string) => listProfiles(beDir).map(toInfo));
  ipcMain.handle(IPC.connTest, (_e, ref: ConnRef) => testConnection(ref));
  ipcMain.handle(IPC.connTestDraft, (_e, conn: ManualConn, password: string) => testDraft(conn, password));
  ipcMain.handle(IPC.manualList, () => listManual());
  ipcMain.handle(IPC.manualSave, (_e, conn: ManualConn, password?: string) => saveManual(conn, password));
  ipcMain.handle(IPC.manualRemove, (_e, id: string) => removeManual(id));
  ipcMain.handle(IPC.dbReverse, (_e, ref: ConnRef, modelDir: string) => reverse(ref, modelDir, getSettings().beDir));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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

  // 시험 모드: ERD_AUTO 에 적은 시나리오를 화면에서 돌리고 결과(JSON)를 출력한 뒤 종료한다
  //   ERD_AUTO=reverse  ERD_BE_DIR, ERD_PROFILE, ERD_MODEL_DIR 로 리버스 → 저장 → 캔버스 노드 수, fps
  const auto = process.env.ERD_AUTO;
  //   ERD_AUTO=manual  ERD_BE_DIR 의 dev 접속 정보로 직접 입력 접속을 만들어 비밀번호 저장, 복호화, 접속을 확인하고 지운다
  if (auto === 'manual') {
    win.webContents.once('did-finish-load', async () => {
      try { console.log('[auto]', JSON.stringify(await manualScenario(process.env.ERD_BE_DIR!))); }
      catch (e) { console.log('[auto] 실패', (e as Error).message); }
      app.quit();
    });
    return;
  }
  if (auto) {
    win.webContents.once('did-finish-load', async () => {
      const args = { scenario: auto, beDir: process.env.ERD_BE_DIR, profile: process.env.ERD_PROFILE ?? 'dev', modelDir: process.env.ERD_MODEL_DIR };
      try {
        const out = await win.webContents.executeJavaScript(`window.__erdAuto(${JSON.stringify(args)})`);
        console.log('[auto]', JSON.stringify(out));
        // ERD_SHOT 을 주면 처음 화면(전체 보기)과 100% 확대 화면을 PNG 로 남긴다
        const shot = process.env.ERD_SHOT;
        if (shot) {
          fs.writeFileSync(shot + '-fit.png', (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript(`document.querySelector('.vue-flow__controls-zoomin')?.click()`);
          for (let i = 0; i < 6; i++) await win.webContents.executeJavaScript(`document.querySelector('.vue-flow__controls-zoomin')?.click()`);
          await new Promise(r => setTimeout(r, 800));
          fs.writeFileSync(shot + '-zoom.png', (await win.webContents.capturePage()).toPNG());
        }
        console.log('[bench]', JSON.stringify(await win.webContents.executeJavaScript('window.__erdBench()')));
      } catch (e) {
        console.log('[auto] 실패', (e as Error).message);
      }
      app.quit();
    });
  }
}

async function manualScenario(beDir: string) {
  const p = getProfile(beDir, 'dev');
  const pw = passwordOf(p, beDir);
  const base = { id: '', name: '시험 접속', driver: 'postgresql' as const, host: p.host, port: p.port, database: p.database, user: p.user, readOnly: true };
  const secretsFile = path.join(app.getPath('userData'), 'secrets.json');
  const out: Record<string, unknown> = {};

  // 1) 저장함: 암호화 파일에 평문이 없고, 메모리를 비워도 복호화해 접속된다
  const saved = await saveManual({ ...base, savePassword: true }, pw);
  const secrets = fs.readFileSync(secretsFile, 'utf8');
  out.secretHasPlain = secrets.includes(pw);
  out.secretSaved = saved.id in JSON.parse(secrets);
  forgetSessionPasswords();
  out.savedTest = (await testConnection({ source: 'manual', id: saved.id })).ok;

  // 2) 저장 안 함으로 바꿈: 파일에서 지워지고, 메모리를 비우면 비밀번호를 다시 요구한다
  await saveManual({ ...saved, savePassword: false });
  out.secretRemoved = !(saved.id in JSON.parse(fs.readFileSync(secretsFile, 'utf8')));
  out.sessionTest = (await testConnection({ source: 'manual', id: saved.id })).ok;
  forgetSessionPasswords();
  const after = await testConnection({ source: 'manual', id: saved.id });
  out.afterRestart = after.ok ? '접속됨(잘못)' : after.message;

  removeManual(saved.id);
  out.listAfterRemove = listManual().length;
  return out;
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
