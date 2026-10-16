import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, type ConnRef, type ManualConn, type PasswordAsk, type ShellKind } from '../shared/ipc';
import { forgetSessionPasswords, listManual, profileSecretStore, removeManual, saveManual } from './db/manual';
import { forgetPassword, hasSavedPassword, setPasswordAsker, setSecretStore } from './db/passwords';
import { profileKey } from './db/connect';
import { readDb, reverse, testConnection, testDraft } from './db/reverse';
import { loadCatalog } from './db/catalog';
import { getProfile, listProfiles, passwordOf, toInfo } from './db/profiles';
import { allowWrite, closeAll, closeSession, commitTx, dirtyTabs, fetchMore, openSession, rollbackTx, runSql } from './db/session';
import { addHistory, listHistory, setHistoryDir } from './history';
import { loadModel, saveModel } from './model-store';
import { getSettings, setSettings } from './settings';
import { inputTerm, killTerm, resizeTerm, setTermEnv, spawnTerm } from './terminal';
import { nextFlywayVersion, writeExport } from './export';
import { startMcp } from './mcp/server';
import { dbQuery } from './mcp/db-query';
import { step10Inputs } from './step10-auto';
import type { ConnRef as Ref, McpInfo, McpReply } from '../shared/ipc';

// ---------- BE 프로필 비밀번호 (2026-10-16) ----------
// properties 에서 자동으로 풀지 못하거나 DB 가 거부하면 화면에 묻는다 (passwords.ts). 답이 올 때까지 기다린다(사람이 입력)
// 화면을 새로 고치면 떠 있던 비밀번호 창이 사라진다. 묻는 내용을 들고 있다가 새 화면에 다시 보낸다(안 그러면 그 접속이 끝없이 기다렸다, 2026-10-16 화면 재현)
const pwWaits = new Map<number, { ok: (a: { password: string; save: boolean } | null) => void; ask: PasswordAsk }>();
let pwSeq = 0;
setSecretStore(profileSecretStore);
setPasswordAsker(req => new Promise(ok => {
  if (!mainWin || mainWin.isDestroyed()) { ok(null); return; }
  const id = ++pwSeq;
  const ask = { label: req.label, reason: req.reason };
  pwWaits.set(id, { ok, ask });
  mainWin.webContents.send(IPC.pwAsk, id, ask);
}));
ipcMain.on(IPC.pwReply, (_e, id: number, answer: { password: string; save: boolean } | null) => {
  pwWaits.get(id)?.ok(answer);
  pwWaits.delete(id);
});
/** 새로 뜬 화면에 아직 답을 못 받은 비밀번호 창을 다시 띄운다 */
const resendPasswordAsks = (win: BrowserWindow) => { for (const [id, w] of pwWaits) win.webContents.send(IPC.pwAsk, id, w.ask); };
/** 창이 없어지면 기다리던 비밀번호 요청을 취소로 끝낸다 */
const cancelPasswordAsks = () => { for (const w of pwWaits.values()) w.ok(null); pwWaits.clear(); };

// ---------- AI 연결 (STEP 8) ----------
let mainWin: BrowserWindow | null = null;
let mcpInfo: McpInfo | null = null;
const mcpWaits = new Map<number, { ok: (t: string) => void; bad: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let mcpSeq = 0;

/** 화면 안에서 끝나는 도구는 15초, DB 를 읽는 도구는 비밀번호 입력과 느린 DB 를 기다려 5분 (15초로는 비밀번호 창이 뜬 채 시간 초과가 났다, 2026-10-16 화면 재현) */
const DB_TOOLS = new Set(['db_compare', 'erd_export']);
const toolTimeout = (tool: string) => (DB_TOOLS.has(tool) ? 300_000 : 15_000);

/** 화면에 기다리는 비밀번호 창이 있으면 그 접속 이름 (시간 초과 안내용) */
const waitingPasswords = () => [...pwWaits.values()].map(w => w.ask.label);

/** ERD 도구 호출을 화면에 맡기고 답을 기다린다 */
function askRenderer(tool: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((ok, bad) => {
    if (!mainWin || mainWin.isDestroyed()) { bad(new Error('ERD 도구 창이 없다')); return; }
    const id = ++mcpSeq;
    const ms = toolTimeout(tool);
    const timer = setTimeout(() => {
      mcpWaits.delete(id);
      const pw = waitingPasswords();
      bad(new Error(`ERD 도구 화면이 ${ms / 1000}초 안에 답하지 않았다${pw.length ? `. 비밀번호 입력을 기다리는 접속이 있다: ${pw.join(', ')}. 사람에게 ERD 도구 창에서 입력해 달라고 한 뒤 다시 부르세요` : ''}`));
    }, ms);
    mcpWaits.set(id, { ok, bad, timer });
    mainWin.webContents.send(IPC.mcpCall, id, tool, args);
  });
}
ipcMain.on(IPC.mcpReply, (_e, id: number, r: McpReply) => {
  const w = mcpWaits.get(id);
  if (!w) return;
  mcpWaits.delete(id);
  clearTimeout(w.timer);
  if (r.error !== undefined) w.bad(new Error(r.error)); else w.ok(r.text ?? '');
});

/** db_query 에 쓸 접속: BE 폴더 프로필 이름과 직접 입력 접속 이름 */
function connRefs(): Map<string, Ref> {
  const m = new Map<string, Ref>();
  const be = getSettings().beDir;
  if (be) { try { for (const p of listProfiles(be)) m.set(p.name, { source: 'be', beDir: be, name: p.name }); } catch { /* BE 폴더 없음 */ } }
  for (const c of listManual()) if (!m.has(c.name)) m.set(c.name, { source: 'manual', id: c.id });
  return m;
}

async function startAi() {
  const h = await startMcp({
    ask: askRenderer,
    query: (conn, sql) => dbQuery(connRefs().get(conn)!, sql),
    connNames: () => [...connRefs().keys()],
  });
  // Claude 는 그 자리 연결 파일(--mcp-config)로 붙는다. 토큰이 들어 있어 앱 설정 폴더에만 둔다. Codex 는 환경변수 토큰을 읽는다
  const claudeConfig = path.join(app.getPath('userData'), 'mcp-erd.json').replace(/\\/g, '/');
  fs.writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { erd: { type: 'http', url: h.url, headers: { Authorization: `Bearer ${h.token}` } } } }, null, 2));
  setTermEnv({ ERD_MCP_URL: h.url, ERD_MCP_TOKEN: h.token });
  mcpInfo = { url: h.url, claudeConfig };
}

function registerIpc(win: BrowserWindow) {
  ipcMain.handle(IPC.pickFolder, async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  // 「ERD 저장」 폴더 (2026-10-16 사용자 지정): 처음 위치는 DB 접속에 쓰는 BE 폴더의 docs/erd, 없으면 사용자 홈
  ipcMain.handle(IPC.modelPickSaveDir, async () => {
    const be = getSettings().beDir;
    const erdDir = be ? path.join(be, 'docs', 'erd') : '';
    const defaultPath = erdDir && fs.existsSync(erdDir) ? erdDir : os.homedir();
    const r = await dialog.showOpenDialog(win, { title: 'ERD 모델을 저장할 폴더', defaultPath, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const hasModel = fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.erd'));
    return { dir, hasModel };
  });
  ipcMain.handle(IPC.pickFile, async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.mcpInfo, () => mcpInfo);
  ipcMain.handle(IPC.exportNextVersion, (_e, dir: string) => nextFlywayVersion(dir));
  ipcMain.handle(IPC.exportWrite, (_e, dir: string, files, history, opts) => writeExport(dir, files, history, opts));
  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch) => setSettings(patch));
  ipcMain.handle(IPC.modelLoad, (_e, dir: string) => loadModel(dir));
  ipcMain.handle(IPC.modelSave, (_e, dir, model, layout) => saveModel(dir, model, layout));
  ipcMain.handle(IPC.connList, (_e, beDir: string) => listProfiles(beDir).map(p => ({ ...toInfo(p), savedPassword: hasSavedPassword(profileKey(beDir, p.name)) })));
  ipcMain.handle(IPC.connForgetPassword, (_e, beDir: string, name: string) => forgetPassword(profileKey(beDir, name)));
  ipcMain.handle(IPC.connTest, (_e, ref: ConnRef) => testConnection(ref));
  ipcMain.handle(IPC.connTestDraft, (_e, conn: ManualConn, password: string) => testDraft(conn, password));
  ipcMain.handle(IPC.manualList, () => listManual());
  ipcMain.handle(IPC.manualSave, (_e, conn: ManualConn, password?: string) => saveManual(conn, password));
  ipcMain.handle(IPC.manualRemove, (_e, id: string) => removeManual(id));
  ipcMain.handle(IPC.dbCatalog, (_e, ref: ConnRef) => loadCatalog(ref));
  ipcMain.handle(IPC.dbRead, (_e, ref: ConnRef) => readDb(ref));
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

  // 창 닫기: 커밋 안 한 탭이나 저장 안 한 ERD 변경이 있으면 화면에 묻는다 (설계 5장 6번)
  // 시험 모드(ERD_AUTO)는 끝에 app.quit() 으로 닫으므로 묻지 않는다 (물으면 시험이 멈춘다)
  let closing = !!process.env.ERD_AUTO;
  let modelDirty = false;
  ipcMain.on(IPC.modelDirty, (_e, d: boolean) => { modelDirty = d; });
  // X 버튼이 아닌 길(화면 안의 window.close(), 새로 고침 Ctrl+R)은 'close' 이벤트를 거치지 않는다.
  // 화면의 beforeunload 가 막으면 여기로 오고, 메인이 창으로 묻는다 (2026-10-16: window.close() 로 묻지 않고 닫혔다)
  win.webContents.on('will-prevent-unload', e => {
    if (closing) { e.preventDefault(); return; } // 이미 X 버튼 확인을 거쳤다
    const sql = dirtyTabs().map(d => d.label);
    const what = [modelDirty ? '저장하지 않은 ERD 변경' : '', sql.length ? `커밋 안 한 SQL 탭(${sql.join(', ')}, 롤백된다)` : ''].filter(Boolean).join(', ');
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['나가기', '머무르기'], defaultId: 1, cancelId: 1, title: 'ERD 도구',
      message: `${what || '저장하지 않은 변경'}이 있다. 화면을 닫거나 새로 고치면 사라진다. 계속할까요?`,
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('close', e => {
    if (closing) return;
    const dirty = dirtyTabs();
    if (!dirty.length && !modelDirty) return;
    e.preventDefault();
    win.webContents.send(IPC.closeRequest, dirty, modelDirty);
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
  mainWin = win;
  // 화면을 (새로) 불러올 때마다: 답을 못 받은 비밀번호 창은 다시 띄우고, 옛 화면에 맡긴 AI 도구 호출은 답이 오지 않으니 취소로 끝낸다
  win.webContents.on('did-finish-load', () => {
    resendPasswordAsks(win);
    for (const w of mcpWaits.values()) { clearTimeout(w.timer); w.bad(new Error('ERD 도구 화면을 새로 고쳐 이 호출은 취소됐다. 다시 부르세요')); }
    mcpWaits.clear();
  });
  win.on('closed', cancelPasswordAsks);

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
      const args = { scenario: auto, beDir: process.env.ERD_BE_DIR, profile: process.env.ERD_PROFILE ?? 'dev', modelDir: process.env.ERD_MODEL_DIR, exportDir: process.env.ERD_EXPORT_DIR, measure: process.env.ERD_MEASURE, dbms: process.env.ERD_DBMS };
      //   ERD_AUTO=step7  ERD_EXPORT_DIR(시험용 임시 폴더)에 Flyway, 이력, MD 파일을 만든다. 이력 파일은 허브 원본을 그 폴더로 복사해 쓴다
      if (auto === 'step7' && args.exportDir && args.beDir) {
        const be = args.beDir.replace(/[\\/]+$/, '');
        const hub = path.join(path.dirname(be), 'docs-hub', 'spec', path.basename(be).replace(/-be$/, ''), '_knowledge/patterns/20-database/40-schema/99-migration-history.md');
        fs.mkdirSync(args.exportDir, { recursive: true });
        fs.copyFileSync(hub, path.join(args.exportDir, '99-migration-history.md'));
      }
      try {
        const out = await win.webContents.executeJavaScript(`window.__erdAuto(${JSON.stringify(args)})`);
        console.log('[auto]', JSON.stringify(out));
        //   ERD_AUTO=sql  SQL 탭, 터미널 탭 시험. ERD_SHOT 을 주면 두 탭 화면을 남긴다
        //   ERD_AUTO=step5  DB 비교, ERD 차이 적용(전체 실행 후 롤백). ERD_SHOT 을 주면 비교 탭과 적용 탭 화면을 남긴다
        //   ERD_AUTO=step6  ERD 수정 → dev 적용(커밋) → 다시 읽어 차이 0 → 되돌리기로 시험 테이블 지움. ERD_SHOT 을 주면 편집 화면을 남긴다
        //   ERD_AUTO=dbms  ERD_DBMS(JSON 배열: 직접 입력 접속과 비밀번호, 시험 SQL)마다 접속 시험 → 리버스 → 저장 → 캔버스 → SQL 탭 조회. ERD_SHOT 이면 DB 마다 화면을 남긴다
        if (auto === 'dbms') {
          const shot = process.env.ERD_SHOT;
          if (shot) fs.writeFileSync(`${shot}-dbms.png`, (await win.webContents.capturePage()).toPNG());
          app.quit();
          return;
        }
        //   ERD_AUTO=step10  편집 편의 기능을 실제 키보드, 마우스 입력으로 시험한다. ERD_STEP10 에 고를 부분(enter), ERD_SHOT 이면 화면을 남긴다
        if (auto === 'step10') {
          console.log('[step10]', JSON.stringify(await step10Inputs(win, process.env.ERD_STEP10 ?? 'enter')));
          const shot = process.env.ERD_SHOT;
          if (shot) fs.writeFileSync(`${shot}-step10.png`, (await win.webContents.capturePage()).toPNG());
          app.quit();
          return;
        }
        //   ERD_AUTO=suggest  SQL 탭 자동완성 목록의 항목 글자와 색을 재고, ERD_SHOT 이면 화면을 남긴다
        if (auto === 'suggest') {
          const shot = process.env.ERD_SHOT;
          if (shot) fs.writeFileSync(`${shot}-suggest.png`, (await win.webContents.capturePage()).toPNG());
          app.quit();
          return;
        }
        //   ERD_AUTO=mcp  모델을 열고 ERD_MEASURE 밀리초(기본 60초) 기다린다. 그동안 밖에서 MCP 도구를 직접 불러 본다
        //   ERD_AUTO=password  비밀번호 창(자동 실패, 틀림, 취소). 끝에 비밀번호 저장소(Windows 계정 암호화)에 시험 값을 넣고 읽고 지운다
        if (auto === 'password') {
          const k = 'be:erd-tool-store-probe:dev';
          await profileSecretStore.save(k, 'probe-value');
          const secretsText = fs.readFileSync(path.join(app.getPath('userData'), 'secrets.json'), 'utf8');
          const store = { plainInFile: secretsText.includes('probe-value'), has: profileSecretStore.has(k), loaded: (await profileSecretStore.load(k)) === 'probe-value' };
          await profileSecretStore.remove(k);
          console.log('[store]', JSON.stringify({ ...store, removed: !profileSecretStore.has(k) }));
          app.quit();
          return;
        }
        //   ERD_AUTO=step8  실제 claude 로 AI 변경 → 강조, 다른 테이블 위치 그대로 확인. ERD_SHOT 이면 확정 대기 화면을 남기고, 끝에 취소한다
        if (auto === 'step8') {
          const shot = process.env.ERD_SHOT;
          if (shot && !process.env.ERD_MEASURE) fs.writeFileSync(`${shot}-pending.png`, (await win.webContents.capturePage()).toPNG());
          console.log('[cancel]', JSON.stringify(await win.webContents.executeJavaScript('window.__erdAiCancel()')));
          app.quit();
          return;
        }
        if (auto === 'step7') {
          const shot = process.env.ERD_SHOT;
          if (shot) {
            for (const id of ['compare', 'export']) {
              await win.webContents.executeJavaScript(`window.__erdActivate(${JSON.stringify(id)})`);
              fs.writeFileSync(`${shot}-${id}.png`, (await win.webContents.capturePage()).toPNG());
            }
          }
          app.quit();
          return;
        }
        if (auto === 'step6') {
          const shot = process.env.ERD_SHOT;
          if (shot) {
            console.log('[shot]', JSON.stringify(await win.webContents.executeJavaScript('window.__erdStep6Shot()')));
            fs.writeFileSync(`${shot}-edit.png`, (await win.webContents.capturePage()).toPNG());
          }
          app.quit();
          return;
        }
        if (auto === 'step5') {
          const shot = process.env.ERD_SHOT;
          if (shot) {
            for (const [name, id] of [['compare', 'compare'], ['apply', (out.tabs as Record<string, string>).apply]]) {
              await win.webContents.executeJavaScript(`window.__erdActivate(${JSON.stringify(id)})`);
              fs.writeFileSync(`${shot}-${name}.png`, (await win.webContents.capturePage()).toPNG());
            }
          }
          app.quit();
          return;
        }
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
  const base = { id: '', name: '시험 접속', driver: p.dialect ?? 'postgresql', host: p.host, port: p.port, database: p.database, user: p.user, readOnly: true };
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

app.whenReady().then(async () => {
  setHistoryDir(path.join(app.getPath('userData'), 'history'));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  // AI 연결을 못 띄워도 나머지 기능은 쓴다
  await startAi().catch(e => console.log('[mcp] 시작 실패', (e as Error).message));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
