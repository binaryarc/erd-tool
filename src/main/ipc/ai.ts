import { app, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { API, type ConnRef as Ref, type McpInfo, type McpReply, type PasswordAsk } from '../../shared/ipc';
import { listManual, profileSecretStore } from '../db/manual';
import { setPasswordAsker, setSecretStore } from '../db/passwords';
import { listProfiles } from '../db/profiles';
import { getSettings } from '../settings';
import { setTermEnv } from '../terminal';
import { startMcp } from '../mcp/server';
import { dbQuery } from '../mcp/db-query';

let mainWin: BrowserWindow | null = null;
export const setMainWin = (win: BrowserWindow) => { mainWin = win; };

// ---------- BE 프로필 비밀번호 (2026-10-16) ----------
// properties 에서 자동으로 풀지 못하거나 DB 가 거부하면 화면에 묻는다 (passwords.ts). 답이 올 때까지 기다린다(사람이 입력)
// 화면을 새로 고치면 떠 있던 비밀번호 창이 사라진다. 묻는 내용을 들고 있다가 새 화면에 다시 보낸다(안 그러면 그 접속이 끝없이 기다렸다, 2026-10-16 화면 재현)
const pwWaits = new Map<number, { ok: (a: { password: string; save: boolean } | null) => void; ask: PasswordAsk }>();
let pwSeq = 0;

/** 새로 뜬 화면에 아직 답을 못 받은 비밀번호 창을 다시 띄운다 */
export const resendPasswordAsks = (win: BrowserWindow) => { for (const [id, w] of pwWaits) win.webContents.send(API.password.onAsk.channel, id, w.ask); };
/** 창이 없어지면 기다리던 비밀번호 요청을 취소로 끝낸다 */
export const cancelPasswordAsks = () => { for (const w of pwWaits.values()) w.ok(null); pwWaits.clear(); };

// ---------- AI 연결 (STEP 8) ----------
let mcpInfo: McpInfo | null = null;
const mcpWaits = new Map<number, { ok: (t: string) => void; bad: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let mcpSeq = 0;

/** 화면 안에서 끝나는 도구는 15초, DB 를 읽는 도구는 비밀번호 입력과 느린 DB 를 기다려 5분 (15초로는 비밀번호 창이 뜬 채 시간 초과가 났다, 2026-10-16 화면 재현) */
const DB_TOOLS = new Set(['db_compare', 'erd_export']);
const toolTimeout = (tool: string) => (DB_TOOLS.has(tool) ? 300_000 : 15_000);

/** 화면에 기다리는 비밀번호 창이 있으면 그 접속 이름 (시간 초과 안내용) */
const waitingPasswords = () => [...pwWaits.values()].map(w => w.ask.label);

/** 옛 화면에 맡긴 AI 도구 호출은 답이 오지 않으니 취소로 끝낸다 */
export function cancelMcpWaits() {
  for (const w of mcpWaits.values()) { clearTimeout(w.timer); w.bad(new Error('ERD 도구 화면을 새로 고쳐 이 호출은 취소됐다. 다시 부르세요')); }
  mcpWaits.clear();
}

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
    mainWin.webContents.send(API.mcp.onCall.channel, id, tool, args);
  });
}

/** db_query 에 쓸 접속: BE 폴더 프로필 이름과 직접 입력 접속 이름 */
function connRefs(): Map<string, Ref> {
  const m = new Map<string, Ref>();
  const be = getSettings().beDir;
  if (be) { try { for (const p of listProfiles(be)) m.set(p.name, { source: 'be', beDir: be, name: p.name }); } catch { /* BE 폴더 없음 */ } }
  for (const c of listManual()) if (!m.has(c.name)) m.set(c.name, { source: 'manual', id: c.id });
  return m;
}

/** 비밀번호 묻기와 AI 연결의 IPC 를 앱을 켤 때 한 번 등록한다 */
export function registerAiIpc() {
  setSecretStore(profileSecretStore);
  setPasswordAsker(req => new Promise(ok => {
    if (!mainWin || mainWin.isDestroyed()) { ok(null); return; }
    const id = ++pwSeq;
    const ask = { label: req.label, reason: req.reason };
    pwWaits.set(id, { ok, ask });
    mainWin.webContents.send(API.password.onAsk.channel, id, ask);
  }));
  ipcMain.on(API.password.reply.channel, (_e, id: number, answer: { password: string; save: boolean } | null) => {
    pwWaits.get(id)?.ok(answer);
    pwWaits.delete(id);
  });
  ipcMain.on(API.mcp.reply.channel, (_e, id: number, r: McpReply) => {
    const w = mcpWaits.get(id);
    if (!w) return;
    mcpWaits.delete(id);
    clearTimeout(w.timer);
    if (r.error !== undefined) w.bad(new Error(r.error)); else w.ok(r.text ?? '');
  });
  ipcMain.handle(API.mcp.info.channel, () => mcpInfo);
}

export async function startAi() {
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
