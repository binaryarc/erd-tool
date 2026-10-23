import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { setWritableProfiles } from './db/profiles';
import { closeAll } from './db/session';
import { setHistoryDir } from './history';
import { getSettings } from './settings';
import { cancelMcpWaits, cancelPasswordAsks, registerAiIpc, resendPasswordAsks, setMainWin, startAi } from './ipc/ai';
import { registerConnectionsIpc } from './ipc/connections';
import { registerExportIpc } from './ipc/export';
import { registerFilesIpc } from './ipc/files';
import { registerSettingsIpc } from './ipc/settings';
import { registerSqlIpc } from './ipc/sql';
import { registerTerminalIpc } from './ipc/terminal';
import { registerWindowCloseIpc } from './ipc/window-close';

registerAiIpc();

function registerIpc(win: BrowserWindow) {
  setWritableProfiles(getSettings().writableProfiles);
  registerFilesIpc(win);
  registerSettingsIpc();
  registerExportIpc();
  registerConnectionsIpc();
  registerSqlIpc();
  registerTerminalIpc(win);
  registerWindowCloseIpc(win);
}

// 앱을 끌 때는 셸에 kill 을 보내지 않는다. Windows 에서 node-pty 의 kill 은 콘솔 목록을 읽는 보조 프로세스를 띄우는데,
// 앱이 끝나는 중이면 그 프로세스가 「AttachConsole failed」 오류를 낸다. 앱이 끝나면 의사 콘솔이 닫혀 셸도 같이 끝난다.
app.on('before-quit', () => { void closeAll(); });

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
  setMainWin(win);
  // 화면을 (새로) 불러올 때마다: 답을 못 받은 비밀번호 창은 다시 띄우고, 옛 화면에 맡긴 AI 도구 호출은 답이 오지 않으니 취소로 끝낸다
  win.webContents.on('did-finish-load', () => {
    resendPasswordAsks(win);
    cancelMcpWaits();
  });
  win.on('closed', cancelPasswordAsks);

  // 시험 모드: 시나리오는 src/main/auto/run.ts. 설치용 빌드에서는 이 줄과 그 파일이 빠진다.
  // 화면을 불러오기 전에 시나리오가 did-finish-load 를 받을 준비를 마친다
  const auto = __ERD_AUTO__ && process.env.ERD_AUTO ? import('./auto/run').then(m => m.runAuto(win)) : Promise.resolve();
  void auto.then(() => {
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  });
}

// 시험 모드는 ERD_USER_DATA 폴더를 앱 설정 폴더로 쓴다. 사용자의 설정(패널 크기, 접속 정보, 이력)을 건드리지 않고,
// 사용자가 띄워 둔 앱과 캐시 폴더가 겹치지 않게 하기 위해서다
if (process.env.ERD_USER_DATA) app.setPath('userData', process.env.ERD_USER_DATA);

app.whenReady().then(async () => {
  setHistoryDir(path.join(app.getPath('userData'), 'history'));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  // AI 연결을 못 띄워도 나머지 기능은 쓴다
  await startAi().catch(e => console.log('[mcp] 시작 실패', (e as Error).message));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
