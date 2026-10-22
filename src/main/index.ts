import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, type ConnRef, type ManualConn, type PasswordAsk, type ShellKind } from '../shared/ipc';
import { listManual, profileSecretStore, removeManual, saveManual } from './db/manual';
import { forgetPassword, hasSavedPassword, setPasswordAsker, setSecretStore } from './db/passwords';
import { profileKey } from './db/connect';
import { readDb, reverse, testConnection, testDraft } from './db/reverse';
import { loadCatalog } from './db/catalog';
import { listProfiles, setWritableProfiles, toInfo } from './db/profiles';
import { allowWrite, closeAll, closeSession, commitTx, dirtyTabs, fetchMore, openSession, rollbackTx, runSql } from './db/session';
import { addHistory, listHistory, setHistoryDir } from './history';
import { loadModel, modelDirOfFile, planSave, saveModel } from './model-store';
import { getSession, getSettings, setSession, setSettings } from './settings';
import { inputTerm, killTerm, resizeTerm, setTermEnv, spawnTerm } from './terminal';
import { findFlywayDir, nextFlywayVersion, readTemplates, writeExport } from './export';
import { startMcp } from './mcp/server';
import { dbQuery } from './mcp/db-query';
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
  setWritableProfiles(getSettings().writableProfiles);
  ipcMain.handle(IPC.pickFolder, async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  // 「ERD 저장」 폴더 (2026-10-16 사용자 지정): 처음 위치는 지금 모델 폴더(없으면 그 위 폴더), 둘 다 없으면 사용자 홈
  ipcMain.handle(IPC.modelPickSaveDir, async () => {
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
  ipcMain.handle(IPC.modelPickOpen, async (_e, defaultDir?: string) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'ERD 폴더 열기: 폴더 안의 파일을 하나 고르세요 (예: _index.erd)', defaultPath: defaultDir, buttonLabel: '이 폴더 열기',
      properties: ['openFile'], filters: [{ name: '모든 파일', extensions: ['*'] }, { name: 'ERD 모델', extensions: ['erd'] }],
    });
    return r.canceled || !r.filePaths[0] ? null : modelDirOfFile(r.filePaths[0]);
  });
  ipcMain.handle(IPC.modelPlanSave, async (_e, dir: string, model, layout) => {
    const { out: _out, ...plan } = await planSave(dir, model, layout);
    return plan;
  });
  ipcMain.handle(IPC.pickFile, async (_e, defaultPath?: string, kind: 'md' | 'json' = 'md') => {
    const filter = kind === 'json' ? { name: 'JSON', extensions: ['json'] } : { name: 'Markdown', extensions: ['md'] };
    const r = await dialog.showOpenDialog(win, { defaultPath, properties: ['openFile'], filters: [filter] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.mcpInfo, () => mcpInfo);
  ipcMain.handle(IPC.exportNextVersion, (_e, dir: string) => nextFlywayVersion(dir));
  ipcMain.handle(IPC.exportFlywayDir, (_e, beDir: string) => findFlywayDir(beDir));
  ipcMain.handle(IPC.exportTemplates, (_e, dir: string) => readTemplates(dir));
  ipcMain.handle(IPC.exportWrite, (_e, dir: string, files, history, opts) => writeExport(dir, files, history, opts));
  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch) => setSettings(patch));
  ipcMain.handle(IPC.sessionGet, () => getSession());
  ipcMain.handle(IPC.sessionSet, (_e, data) => setSession(data));
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
  ipcMain.handle(IPC.dbReverse, (_e, ref: ConnRef, modelDir: string) => {
    const s = getSettings();
    return reverse(ref, modelDir, { file: s.groupRulesFile, prefixes: s.groupPrefixes });
  });

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
  // 마지막 화면 시험(ERD_SESSION)은 X 버튼과 같은 길로 닫아 본다
  let closing = !!process.env.ERD_AUTO && !process.env.ERD_SESSION;
  let modelDirty = false;
  ipcMain.on(IPC.modelDirty, (_e, d: boolean) => { modelDirty = d; });
  // X 버튼이 아닌 길(화면 안의 window.close(), 새로 고침 Ctrl+R)은 'close' 이벤트를 거치지 않는다.
  // 화면의 beforeunload 가 막으면 여기로 오고, 메인이 창으로 묻는다 (2026-10-16: window.close() 로 묻지 않고 닫혔다)
  win.webContents.on('will-prevent-unload', e => {
    if (closing) { e.preventDefault(); return; } // 이미 X 버튼 확인을 거쳤다
    const sql = dirtyTabs().map(d => d.label);
    const what = [modelDirty ? '저장하지 않은 ERD 변경' : '', sql.length ? `커밋하지 않은 SQL 탭(${sql.join(', ')}, 롤백됩니다)` : ''].filter(Boolean).join(', ');
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['나가기', '머무르기'], defaultId: 1, cancelId: 1, title: 'ERD 도구',
      message: `${what || '저장하지 않은 변경'}이 있습니다. 화면을 닫거나 새로 고치면 사라집니다. 계속할까요?`,
    });
    if (choice === 0) e.preventDefault();
  });
  // 창을 닫을 때는 항상 화면에 먼저 알린다. 화면이 마지막 화면(session.json)을 쓰고, 커밋 안 한 SQL 탭이 있으면 묻는다 (STEP 10).
  // 저장 안 한 ERD 변경은 마지막 화면에 담겨 다시 켜면 돌아오므로 묻지 않는다.
  // 화면이 답하지 않으면(멈춤) 3초 뒤 다시 누른 X 는 그냥 닫는다
  let askedAt = 0;
  win.on('close', e => {
    if (closing) return;
    if (askedAt && Date.now() - askedAt > 3000) return;
    e.preventDefault();
    askedAt = Date.now();
    win.webContents.send(IPC.closeRequest, dirtyTabs(), modelDirty);
  });
  ipcMain.on(IPC.closeConfirm, (_e, ok: boolean) => {
    askedAt = 0;
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
