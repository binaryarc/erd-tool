import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC, type ConnRef, type ManualConn, type ShellKind } from '../shared/ipc';
import { forgetSessionPasswords, listManual, removeManual, saveManual } from './db/manual';
import { reverse, testConnection, testDraft } from './db/reverse';
import { loadCatalog } from './db/catalog';
import { getProfile, listProfiles, passwordOf, toInfo } from './db/profiles';
import { allowWrite, closeAll, closeSession, commitTx, dirtyTabs, fetchMore, openSession, rollbackTx, runSql } from './db/session';
import { addHistory, listHistory, setHistoryDir } from './history';
import { loadModel, saveModel } from './model-store';
import { getSettings, setSettings } from './settings';
import { inputTerm, killTerm, resizeTerm, spawnTerm } from './terminal';

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
  ipcMain.handle(IPC.dbCatalog, (_e, ref: ConnRef) => loadCatalog(ref));
  ipcMain.handle(IPC.dbReverse, (_e, ref: ConnRef, modelDir: string) => reverse(ref, modelDir, getSettings().beDir));

  // SQL 탭 (설계 5장). 성공한 문장은 리터럴을 지워 이력에 남긴다
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

  // 터미널 (설계 11장)
  ipcMain.handle(IPC.termSpawn, (_e, id: string, kind: ShellKind, cols: number, rows: number) =>
    spawnTerm(id, kind, cols, rows,
      d => !win.isDestroyed() && win.webContents.send(IPC.termData, id, d),
      c => !win.isDestroyed() && win.webContents.send(IPC.termExit, id, c)));
  ipcMain.on(IPC.termInput, (_e, id: string, d: string) => inputTerm(id, d));
  ipcMain.on(IPC.termResize, (_e, id: string, c: number, r: number) => resizeTerm(id, c, r));
  ipcMain.on(IPC.termKill, (_e, id: string) => killTerm(id));

  // 창 닫기: 커밋 안 한 탭이 있으면 화면에 묻는다 (설계 5장 6번)
  let closing = false;
  win.on('close', e => {
    if (closing) return;
    const dirty = dirtyTabs();
    if (!dirty.length) return;
    e.preventDefault();
    win.webContents.send(IPC.closeRequest, dirty);
  });
  ipcMain.on(IPC.closeConfirm, (_e, ok: boolean) => {
    if (!ok) return;
    closing = true;
    win.close();
  });
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
    // 시험 모드에서는 화면 쪽 오류와 불러오기 실패를 그대로 출력한다 (멈춘 곳을 찾기 위해)
    win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 'warning') console.log('[renderer]', e.level, e.message.slice(0, 300)); });
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[load-fail]', code, desc));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer-gone]', d.reason, d.exitCode));
    win.webContents.once('did-finish-load', async () => {
      console.log('[loaded]');
      const args = { scenario: auto, beDir: process.env.ERD_BE_DIR, profile: process.env.ERD_PROFILE ?? 'dev', modelDir: process.env.ERD_MODEL_DIR };
      try {
        const out = await win.webContents.executeJavaScript(`window.__erdAuto(${JSON.stringify(args)})`);
        console.log('[auto]', JSON.stringify(out));
        //   ERD_AUTO=sql  SQL 탭, 터미널 탭 시험. ERD_SHOT 을 주면 두 탭 화면을 남긴다
        if (auto === 'sql') {
          // 경계선 끌기: 실제 마우스 입력으로 터미널 위 경계선을 100px 올리고, 왼쪽 패널 경계선을 80px 오른쪽으로
          const js = (s: string) => win.webContents.executeJavaScript(s);
          const rect = (sel: string) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
          const drag = async (x: number, y: number, dx: number, dy: number) => {
            const ev = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', px: number, py: number) =>
              win.webContents.sendInputEvent({ type, x: Math.round(px), y: Math.round(py), button: 'left', clickCount: 1 });
            ev('mouseDown', x, y);
            for (let i = 1; i <= 5; i++) { ev('mouseMove', x + (dx * i) / 5, y + (dy * i) / 5); await new Promise(r => setTimeout(r, 30)); }
            ev('mouseUp', x + dx, y + dy);
            await new Promise(r => setTimeout(r, 300));
          };
          const termBefore = await rect('.term-panel');
          const leftBefore = await rect('.panel');
          await drag(termBefore.x + 200, termBefore.y - 2, 0, -100);
          await drag(leftBefore.x + leftBefore.w + 2, leftBefore.y + 200, 80, 0);
          const termAfter = await rect('.term-panel');
          const leftAfter = await rect('.panel');
          console.log('[resize]', JSON.stringify({
            terminalHeight: [Math.round(termBefore.h), Math.round(termAfter.h)], leftWidth: [Math.round(leftBefore.w), Math.round(leftAfter.w)],
            saved: await js(`[localStorage.getItem('split:terminal'), localStorage.getItem('split:left')]`),
          }));

          // SQL 결과 그리드 촘촘함
          await js(`window.__erdActivate('sql-1')`);
          console.log('[grid]', JSON.stringify(await js('window.__erdGrid()')));

          // ERD: 트리 정렬, 직선, 한 번 클릭 → 선택 테두리, 더블클릭 → 미니 ERD
          await js(`window.__erdActivate('erd')`);
          console.log('[tree]', JSON.stringify(await js(`window.__erdView({ mode: 'tree', edge: 'straight' })`)));
          await js(`window.__erdView({ mode: 'tree' })`);
          await new Promise(r => setTimeout(r, 1000));
          const p = await js(`window.__erdNodeRect('mst_center')`);
          if (p) {
            console.log('[hit]', JSON.stringify(await js(`(() => { const e = document.elementFromPoint(${Math.round(p.x)}, ${Math.round(p.y)});
              return { at: [${Math.round(p.x)}, ${Math.round(p.y)}], el: e?.tagName + '.' + e?.className, node: e?.closest('.vue-flow__node')?.className ?? null }; })()`)));
            const click = (count: number) => {
              win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: count });
              win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: count });
            };
            click(1);
            await new Promise(r => setTimeout(r, 400));
            const afterClick = await js('window.__erdInspect()');
            click(1); click(2);
            await new Promise(r => setTimeout(r, 1500));
            console.log('[select]', JSON.stringify({ afterClick, afterDouble: await js('window.__erdInspect()') }));
          } else console.log('[select] mst_center 노드를 화면에서 찾지 못함');
          const shot = process.env.ERD_SHOT;
          if (shot) {
            for (const [name, id] of Object.entries(out.tabs as Record<string, string>)) {
              await win.webContents.executeJavaScript(`window.__erdActivate(${JSON.stringify(id)})`);
              fs.writeFileSync(`${shot}-${name}.png`, (await win.webContents.capturePage()).toPNG());
            }
          }
          app.quit();
          return;
        }
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

// 시험 모드는 ERD_USER_DATA 폴더를 앱 설정 폴더로 쓴다. 사용자의 설정(패널 크기, 접속 정보, 이력)을 건드리지 않고,
// 사용자가 띄워 둔 앱과 캐시 폴더가 겹치지 않게 하기 위해서다
if (process.env.ERD_USER_DATA) app.setPath('userData', process.env.ERD_USER_DATA);

app.whenReady().then(() => {
  setHistoryDir(path.join(app.getPath('userData'), 'history'));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
