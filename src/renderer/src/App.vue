<script setup lang="ts">
// 화면: 왼쪽 접속 패널, 가운데 ERD 캔버스. 위: 모델 폴더, 저장, 보기 모드, 자동 정렬.
import { computed, nextTick, provide, reactive, ref, shallowRef, watch } from 'vue';
import ConnPanel from './components/ConnPanel.vue';
import ErdCanvas from './components/ErdCanvas.vue';
import SqlTab from './components/SqlTab.vue';
import CompareTab from './components/CompareTab.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import SplitPane from './components/SplitPane.vue';
import TableEditor from './components/TableEditor.vue';
import ExportTab from './components/ExportTab.vue';
import { EditHistory, addColumn, addFk, addTable, updateTable } from '../../shared/model/edit';
import { buildCreateAll } from '../../shared/sql/create';
import { diffModels } from '../../shared/model/diff';
import { buildJoinSelect } from '../../shared/sql/join';
import { DEFAULT_DIAGRAM, syncLayout } from '../../shared/model/arrange';
import { arrangeMode, emptyLayout, type Diagram, type Layout } from '../../shared/model/layout';
import type { ModelError, SchemaModel } from '../../shared/model/types';
import type { ReverseResult, ShellKind } from '../../shared/ipc';
import { VIEW_KEY, loadPref, savePref, type ViewState } from './view';
import { neighborhood } from '../../shared/model/tree';
import { applyCommands } from '../../shared/ai/commands';
import { findSpotNear } from '../../shared/ai/place';
import { diffText, overview, tablesText, viewStateText } from '../../shared/ai/notation';
import { buildAlter } from '../../shared/sql/alter';
import { buildSchemaDocs } from '../../shared/export/md';
import { buildFlyway, suggestDescription } from '../../shared/export/flyway';
import { loadConnOptions } from './conn-options';

const view = reactive<ViewState>({
  nameMode: loadPref('nameMode', 'both', ['physical', 'logical', 'both'] as const),
  edgeKind: loadPref('edgeKind', 'smoothstep', ['smoothstep', 'straight', 'default'] as const),
  compactOnZoomOut: false, compact: false,
});
watch(() => view.nameMode, v => savePref('nameMode', v));
watch(() => view.edgeKind, v => savePref('edgeKind', v));
provide(VIEW_KEY, view);

const modelDir = ref('');
const model = shallowRef<SchemaModel | null>(null);
const layout = shallowRef<Layout>(emptyLayout());
const diagram = shallowRef<Diagram | null>(null);
const version = ref(0);
const errors = ref<ModelError[]>([]);
const message = ref('');
const dirty = ref(false);
const panel = ref<InstanceType<typeof ConnPanel>>();
const canvas = ref<InstanceType<typeof ErdCanvas>>();
/** 본 ERD 를 전체 보기로 맞추는 때: 모델을 불러올 때만 (고칠 때마다 화면이 튀지 않게) */
const fitKey = ref(0);

window.erd.settings.get().then(s => { if (s.modelDir) modelDir.value = s.modelDir; });

function show(m: SchemaModel, l: Layout) {
  model.value = m;
  layout.value = l;
  diagram.value = syncLayout(m, l, DEFAULT_DIAGRAM);
  version.value++;
  fitKey.value++;
  history.clear();
  syncHistory();
  aiBase.value = null;
  aiSteps.length = 0;
}

// ---------- ERD 수정 (STEP 6) ----------
// 수정 명령(shared/model/edit.ts)은 새 모델을 돌려준다. 되돌리기는 수정 직전 모델을 기록해 두고 바꿔 끼운다.
// 끌어 옮긴 위치(layout)는 되돌리기 대상이 아니다. 지운 테이블을 되살리면 위치는 그룹 규칙대로 다시 놓인다.
const history = new EditHistory();
const canUndo = ref(false);
const canRedo = ref(false);
function syncHistory() { canUndo.value = history.canUndo; canRedo.value = history.canRedo; }

/** 편집 패널에 띄운 테이블 ID. 이름이 아니라 ID 로 들고 있어야 이름을 바꾸거나 되돌려도 패널이 따라간다 */
const editId = ref('');
const editName = computed(() => model.value?.tables.find(t => t.id === editId.value)?.name ?? '');

function setModel(m: SchemaModel) {
  model.value = m;
  diagram.value = syncLayout(m, layout.value, DEFAULT_DIAGRAM);
  version.value++;
  dirty.value = true;
  syncHistory();
  if (miniName.value && !m.tables.some(t => t.name === miniName.value)) miniName.value = '';
}

function edit(fn: (m: SchemaModel) => SchemaModel, done?: (ok: boolean) => void): boolean {
  if (!model.value) { done?.(false); return false; }
  let next: SchemaModel;
  try { next = fn(model.value); }
  catch (e) { message.value = `수정 안 됨: ${(e as Error).message}`; done?.(false); return false; }
  if (next !== model.value) {
    history.push(model.value);
    setModel(next);
    message.value = '수정함 (저장 전)';
  }
  done?.(true);
  return true;
}

function undo() {
  const m = model.value && history.undo(model.value);
  if (m) { setModel(m); message.value = '되돌림'; }
}
function redo() {
  const m = model.value && history.redo(model.value);
  if (m) { setModel(m); message.value = '다시 함'; }
}

function openEditor(name: string) {
  const t = model.value?.tables.find(x => x.name === name);
  if (!t) return;
  miniName.value = '';
  editId.value = t.id;
}

/** 새 테이블: 겹치지 않는 임시 이름으로 만들고 편집 패널을 연다. 공통 컬럼(reg_id 등)이 정의돼 있으면 넣는다 */
async function newTable() {
  if (!model.value) return;
  const names = new Set(model.value.tables.map(t => t.name));
  let name = 'new_table';
  for (let i = 2; names.has(name); i++) name = `new_table_${i}`;
  if (!edit(m => addTable(m, name, { withCommon: m.common.length > 0 }))) return;
  openEditor(name);
  await nextTick();
  await canvas.value?.focusTable(name);
}

/** 모델 전체 CREATE 를 새 SQL 탭에 (바로 실행하지 않는다) */
function createAll() {
  if (model.value) addSql(buildCreateAll(model.value).sql);
}

/** 고친 ERD 를 DB 에 적용: DB 비교 탭에서 오른쪽을 지금 ERD 로 두고 비교한다. 적용은 비교 탭의 「왼쪽 DB 에 적용」으로 (STEP 5) */
async function applyToDb() {
  openCompare();
  await nextTick();
  await compare.value!.ready;
  compare.value!.setRightErd();
  await compare.value!.compare();
}

// ---------- AI(MCP) 도구 처리 (STEP 8, 설계 10장) ----------
// 메인의 MCP 서버가 ERD 도구 호출을 여기로 넘긴다. 모델과 확정 대기 상태가 화면에 있기 때문이다.
// AI 가 바꾼 것은 첫 변경 직전 모습(aiBase)과 비교해 주황 테두리로 강조하고, 사람이 「확정」하기 전까지 저장을 막는다.
type Pins = Record<string, [number, number]>;
interface AiStep { before: SchemaModel; beforePinned: Pins; after: SchemaModel }
const aiBase = shallowRef<{ model: SchemaModel; pinned: Pins } | null>(null);
const aiSteps: AiStep[] = [];
const pinsNow = (): Pins => ({ ...(diagram.value?.pinned ?? {}) });

/** 확정 대기 중인 테이블 ID: 기준과 구조가 다르거나 고정 좌표가 다른 테이블 */
const aiChanged = computed(() => {
  void version.value; // 고정 좌표는 diagram 을 직접 고치므로 version 으로 다시 계산한다
  const base = aiBase.value, m = model.value;
  if (!base || !m) return new Set<string>();
  const names = new Set(diffModels(base.model, m).map(d => d.table).filter(Boolean));
  const ids = new Set(m.tables.filter(t => names.has(t.name)).map(t => t.id));
  const pins = diagram.value?.pinned ?? {};
  for (const id of new Set([...Object.keys(pins), ...Object.keys(base.pinned)])) {
    if (String(pins[id]) !== String(base.pinned[id]) && m.tables.some(t => t.id === id)) ids.add(id);
  }
  return ids;
});
const nameOf = (id: string) => model.value?.tables.find(t => t.id === id)?.name ?? id;

function needModel(): SchemaModel {
  if (!model.value || !diagram.value) throw new Error('ERD 도구에 열린 모델이 없다. 사람에게 모델 폴더를 열거나 DB 에서 불러와 달라고 하세요');
  return model.value;
}

function setPins(p: Pins) {
  diagram.value!.pinned = { ...p };
  version.value++;
}

async function aiApply(lines: string[]): Promise<string> {
  const before = needModel();
  const beforePinned = pinsNow();
  const r = applyCommands(before, lines); // 실패하면 여기서 끝나고 아무것도 바뀌지 않는다
  history.push(before);
  setModel(r.model);
  const placed: string[] = [];
  try {
    for (const p of r.places) {
      await nextTick();
      const ids = new Map(r.model.tables.map(t => [t.name, t.id]));
      const boxes = canvas.value!.boxes();
      const me = boxes.get(ids.get(p.table)!)!; // 바뀐 크기 (컬럼을 더했으면 더 길다)
      const spot = findSpotNear(boxes, ids.get(p.after)!, ids.get(p.table)!, { w: me.w, h: me.h });
      diagram.value!.pinned[ids.get(p.table)!] = [spot.x, spot.y];
      version.value++;
      placed.push(`${p.table} 를 ${p.after} 옆 빈 자리에 고정했다 (다른 테이블은 그대로)`);
    }
  } catch (e) {
    // 자리를 못 찾으면 전체를 되돌린다 (하나라도 실패하면 아무것도 적용하지 않는다)
    history.undo(model.value!);
    setModel(before);
    setPins(beforePinned);
    throw e;
  }
  if (!aiBase.value) aiBase.value = { model: before, pinned: beforePinned };
  aiSteps.push({ before, beforePinned, after: model.value! });
  version.value++;
  message.value = 'AI 가 고침 (확정 대기)';
  return [
    `적용함: 명령 ${r.done.length}줄`,
    ...placed,
    `확정 대기 중인 테이블: ${[...aiChanged.value].map(nameOf).join(', ')}`,
    '화면에 주황 테두리로 강조됐다. 사람이 「확정」해야 모델 파일에 저장된다',
  ].join('\n');
}

function aiUndo(): string {
  const step = aiSteps.at(-1);
  if (!step) throw new Error('되돌릴 AI 변경이 없다 (사람이 확정했거나 아직 고치지 않았다)');
  if (model.value !== step.after) throw new Error('그 뒤에 사람이 ERD 를 고쳐서 AI 변경만 되돌릴 수 없다');
  aiSteps.pop();
  history.push(model.value);
  setModel(step.before);
  setPins(step.beforePinned);
  if (!aiSteps.length) aiBase.value = null;
  return `마지막 erd_apply 를 되돌렸다. 남은 확정 대기 변경: ${aiSteps.length}번`;
}

/** 사람의 「확정」: 강조만 푼다 (저장은 「저장」 버튼으로) */
function aiConfirm() {
  aiBase.value = null;
  aiSteps.length = 0;
  version.value++;
  message.value = 'AI 변경을 확정함 (저장 전)';
}
/** 사람의 「취소」: AI 가 고치기 전 모습으로 */
function aiCancel() {
  const base = aiBase.value;
  if (!base || !model.value) return;
  history.push(model.value);
  setModel(base.model);
  setPins(base.pinned);
  aiBase.value = null;
  aiSteps.length = 0;
  message.value = 'AI 변경을 취소함';
}

async function aiExport(args: { kind?: string; conn?: string; description?: string }): Promise<string> {
  const m = needModel();
  if (aiBase.value) throw new Error('확정 대기 중인 AI 변경이 있다. 사람이 확정하거나 취소한 뒤 내보낸다');
  const s = await window.erd.settings.get();
  if (args.kind === 'md') {
    const dir = s.exportDirs?.md;
    if (!dir) throw new Error('MD 폴더가 정해지지 않았다. 사람이 내보내기 탭에서 한 번 폴더를 골라야 한다');
    const r = await window.erd.export.write(dir, buildSchemaDocs(m, new Date()), undefined, { overwrite: true });
    return `만든 파일 ${r.written.length}개 (덮어쓴 파일 ${r.replaced.length}개)\n${r.written.join('\n')}`;
  }
  const opts = await loadConnOptions();
  const o = opts.find(x => x.profile === args.conn || x.label.startsWith(`${args.conn} (`));
  if (!o) throw new Error(`접속 ${args.conn ?? ''} 이 없다. 쓸 수 있는 접속: ${opts.map(x => x.profile ?? x.label).join(', ')}`);
  const dir = s.exportDirs?.flyway ?? (s.beDir ? `${s.beDir}/src/main/resource/db/migration` : '');
  if (!dir) throw new Error('Flyway 폴더가 정해지지 않았다. 사람이 DB 비교 탭에서 한 번 만들어야 한다');
  const from = (await window.erd.db.read(o.ref)).model;
  const description = args.description || suggestDescription(diffModels(from, m));
  const f = buildFlyway({ from, to: m, version: await window.erd.export.nextVersion(dir), description, fromLabel: o.label, toLabel: '지금 ERD', now: new Date() });
  const r = await window.erd.export.write(dir, [{ name: f.fileName, content: f.sql }]);
  return `만듦: ${r.written[0]} (문장 ${f.statements}개, 위험 ${f.dangers}개). DB 에는 실행하지 않았다`;
}

/** MCP db_compare: 두 쪽(접속 또는 지금 ERD) 구조 차이. DB 는 읽기 전용 연결로 구조만 읽는다 */
async function aiCompare(args: { from?: string; to?: string; kind?: string; alter?: boolean }): Promise<string> {
  const opts = await loadConnOptions();
  const side = async (name = '') => {
    if (name.toLowerCase() === 'erd') {
      const m = needModel();
      return { model: m, label: aiBase.value ? '지금 ERD (확정 대기 중인 AI 변경 포함)' : '지금 ERD' };
    }
    const o = opts.find(x => x.profile === name || x.label.startsWith(`${name} (`));
    if (!o) throw new Error(`접속 ${name} 이 없다. 쓸 수 있는 것: erd, ${opts.map(x => x.profile ?? x.label).join(', ')}`);
    return { model: (await window.erd.db.read(o.ref)).model, label: o.label };
  };
  const [a, b] = await Promise.all([side(args.from), side(args.to)]);
  const all = diffModels(a.model, b.model);
  const items = args.kind ? all.filter(i => i.kind === args.kind) : all;
  const text = diffText(items, a.label, b.label) + (args.kind ? `\n(${args.kind} 만 봄. 전체 차이 ${all.length}개)` : '');
  return args.alter && items.length ? `${text}\n\n${buildAlter(a.model, b.model, items).sql}` : text;
}

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
let aiQueue: Promise<unknown> = Promise.resolve();
// 도구 호출은 하나씩 처리한다 (AI 가 한꺼번에 불러도 모델이 섞이지 않게)
window.erd.mcp.onCall((id, tool, args) => {
  aiQueue = aiQueue.then(async () => {
    try {
      let text: string;
      if (tool === 'erd_overview') text = overview(needModel());
      else if (tool === 'erd_tables') text = tablesText(needModel(), (args.names as string[]) ?? []);
      else if (tool === 'erd_view_state') { needModel(); text = viewStateText(model.value!, diagram.value!, canvas.value!.boxes(), canvas.value!.zoom(), DEFAULT_DIAGRAM); }
      else if (tool === 'erd_apply') text = await aiApply((args.commands as string[]) ?? []);
      else if (tool === 'erd_undo') text = aiUndo();
      else if (tool === 'erd_export') text = await aiExport(args);
      else if (tool === 'db_compare') text = await aiCompare(args);
      else throw new Error(`모르는 도구: ${tool}`);
      window.erd.mcp.reply(id, { text });
    } catch (e) { window.erd.mcp.reply(id, { error: cleanError(e) }); }
  });
});

async function setModelDir(dir: string) {
  modelDir.value = dir;
  await window.erd.settings.set({ modelDir: dir });
}

/** BE 폴더를 고르면 모델 폴더 기본값을 BE/docs/erd/model 로 (설계 4장 결정) */
async function onBeDir(be: string) {
  if (!modelDir.value) await setModelDir(`${be}/docs/erd/model`);
}

async function openModel(dir?: string) {
  const d = dir ?? await window.erd.pickFolder(modelDir.value || undefined);
  if (!d) return;
  await setModelDir(d);
  const r = await window.erd.model.load(d);
  errors.value = r.errors;
  show(r.model, r.layout);
  dirty.value = false;
  message.value = `불러옴: 테이블 ${r.model.tables.length}개`;
}

function applyReverse(r: ReverseResult) {
  errors.value = [];
  // 모델 폴더의 기존 배치를 쓴다 (화면에 띄운 배치가 아니라). 끌어 옮긴 위치를 지키기 위해서다
  show(r.model, r.layout);
  dirty.value = true;
  message.value = `DB 에서 불러옴: 테이블 ${r.model.tables.length}개 (저장 전)`;
}

async function save() {
  if (!model.value || !modelDir.value) return;
  // 사람이 확정해야 모델 파일에 저장된다 (설계 10-4)
  if (aiBase.value) { message.value = '확정 대기 중인 AI 변경을 확정하거나 취소한 뒤 저장한다'; return; }
  const r = await window.erd.model.save(modelDir.value, model.value, layout.value);
  dirty.value = false;
  message.value = `저장: 바뀐 파일 ${r.written.length}개, 그대로 ${r.unchanged.length}개, 지운 파일 ${r.removed.length}개`;
  return r;
}

function onPin(id: string, x: number, y: number) {
  if (!diagram.value) return;
  diagram.value.pinned[id] = [x, y];
  version.value++;
  dirty.value = true;
}

function autoArrange() {
  if (!diagram.value) return;
  diagram.value.pinned = {};
  version.value++;
  dirty.value = true;
}

/** 정렬 방식(트리, 그룹 격자)은 layout.json 에 다이어그램별로 저장된다. 바꾸면 끌어 옮긴 위치는 지운다 */
function setArrangeMode(mode: 'grid' | 'tree') {
  if (!diagram.value || arrangeMode(diagram.value) === mode) return;
  diagram.value.mode = mode;
  diagram.value.pinned = {};
  version.value++;
  dirty.value = true;
}

// 미니 ERD: 더블클릭한 테이블과 FK 로 바로 이어진 테이블만, 항상 트리로
const miniName = ref('');
const miniModel = computed(() => (model.value && miniName.value ? neighborhood(model.value, miniName.value) : null));
const miniDiagram: Diagram = { mode: 'tree', groups: {}, pinned: {} };
const mini = ref<InstanceType<typeof ErdCanvas>>();
const compare = ref<InstanceType<typeof CompareTab>>();
const editor = ref<InstanceType<typeof TableEditor>>();

// ---------- 위 영역 탭: ERD, SQL / 아래 영역: 터미널 ----------
interface Tab { id: string; kind: 'erd' | 'sql' | 'compare' | 'export'; title: string; dirty: boolean; initialSql?: string; initialConn?: string }
const tabs = ref<Tab[]>([{ id: 'erd', kind: 'erd', title: 'ERD', dirty: false }]);
const activeTab = ref('erd');
const selected = ref<string[]>([]);
const tabRefs = new Map<string, unknown>();
const setTabRef = (id: string, el: unknown) => { if (el) tabRefs.set(id, el); else tabRefs.delete(id); };
let seq = 0;

/** DB 비교 탭은 하나만 연다 */
function openCompare() {
  if (!tabs.value.some(t => t.id === 'compare')) tabs.value.splice(1, 0, { id: 'compare', kind: 'compare', title: 'DB 비교', dirty: false });
  activeTab.value = 'compare';
}

/** 내보내기 탭도 하나만 연다 (STEP 7) */
function openExport() {
  if (!tabs.value.some(t => t.id === 'export')) tabs.value.push({ id: 'export', kind: 'export', title: '내보내기', dirty: false });
  activeTab.value = 'export';
}
const exporter = ref<InstanceType<typeof ExportTab>>();

function addSql(initialSql = '', initialConn?: string) {
  const id = `sql-${++seq}`;
  tabs.value.push({ id, kind: 'sql', title: `SQL ${seq}`, dirty: false, initialSql, initialConn });
  activeTab.value = id;
  return id;
}

// 아래 터미널 영역 (VS Code 처럼). Ctrl+` 로 보이기, 숨기기
const terminals = ref<InstanceType<typeof TerminalPanel>>();
const termVisible = ref(false);
async function addTerm(shell: ShellKind) {
  termVisible.value = true;
  return terminals.value!.add(shell);
}
function toggleTerm() {
  termVisible.value = !termVisible.value;
  if (termVisible.value && !terminals.value!.terms.length) void terminals.value!.add('powershell');
}
window.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerm(); }
  // 되돌리기, 다시 하기는 ERD 탭에서만. 입력 칸 안에서는 그 칸의 글자 되돌리기를 그대로 둔다
  const el = e.target as HTMLElement;
  if (activeTab.value !== 'erd' || !e.ctrlKey || el.closest('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});

/** 커밋 안 한 변경 확인 (탭 닫기, 창 닫기 공통) */
/** BE 프로필 비밀번호 입력 창 (자동으로 풀지 못했거나 DB 가 거부했을 때 메인이 묻는다) */
const pwAsk = ref<{ id: number; label: string; reason: string } | null>(null);
const pwInput = ref({ password: '', save: false });
const pwQueue: { id: number; label: string; reason: string }[] = [];
const pwBox = ref<HTMLInputElement>();
function nextPw() {
  pwAsk.value = pwQueue.shift() ?? null;
  pwInput.value = { password: '', save: false };
  if (pwAsk.value) void nextTick(() => pwBox.value?.focus());
}
window.erd.password.onAsk((id, req) => { pwQueue.push({ id, ...req }); if (!pwAsk.value) nextPw(); });
function answerPw(ok: boolean) {
  if (!pwAsk.value) return;
  window.erd.password.reply(pwAsk.value.id, ok ? { password: pwInput.value.password, save: pwInput.value.save } : null);
  nextPw();
}

const closeAsk = ref<{ labels: string[]; resolve: (a: 'commit' | 'rollback' | 'cancel') => void } | null>(null);
const ask = (labels: string[]) => new Promise<'commit' | 'rollback' | 'cancel'>(resolve => { closeAsk.value = { labels, resolve }; });
function answerClose(a: 'commit' | 'rollback' | 'cancel') { closeAsk.value?.resolve(a); closeAsk.value = null; }

async function closeTab(t: Tab) {
  if (t.kind === 'sql') {
    if (t.dirty) {
      const a = await ask([t.title]);
      if (a === 'cancel') return;
      await window.erd.sql[a](t.id);
    }
    await window.erd.sql.close(t.id);
  }
  tabs.value = tabs.value.filter(x => x.id !== t.id);
  if (activeTab.value === t.id) activeTab.value = tabs.value[tabs.value.length - 1].id;
}

window.erd.onCloseRequest(async dirty => {
  const a = await ask(dirty.map(d => tabs.value.find(t => t.id === d.tabId)?.title ?? d.label));
  if (a !== 'cancel') for (const d of dirty) await window.erd.sql[a](d.tabId);
  window.erd.confirmClose(a !== 'cancel');
});

// 시험 모드 (메인의 ERD_AUTO 가 부른다)
const frames = (n: number) => new Promise<void>(r => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
window.__erdActivate = async (id: string) => { activeTab.value = id; await nextTick(); await frames(5); await sleep(400); };

/** SQL 탭, 터미널 탭 시험 (완료 기준 3 과 힌트 동작) */
async function sqlScenario(beDir: string, dir: string) {
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  await openModel(dir);
  const out: Record<string, unknown> = {};

  const id = addSql();
  await nextTick(); await frames(5);
  type SqlTabApi = InstanceType<typeof SqlTab>;
  const tab = tabRefs.get(id) as SqlTabApi;
  await tab.loadOptions();
  await tab.connect('be:dev');
  out.connect = { options: tab.options(), message: tab.message(), state: tab.state() };
  const ed = tab.editor()!;
  ed.setValue('select g as n, md5(g::text) as h from generate_series(1, 2500) g');
  await tab.run();
  await frames(5); await sleep(300);
  out.grid = { ...tab.grid(), state: tab.state() };

  // 자동완성: 목록을 여는 명령 없이 글자만 쳤을 때 저절로 뜨는지 (DBeaver 처럼)
  await sleep(1500); // 접속한 DB 목록 읽기
  out.catalogTables = tab.catalogSize();
  /** text 를 한 글자씩 친다. suffix 를 주면 커서 뒤에 그 글자가 이미 있는 상태에서 친다 */
  const typeAndRead = async (text: string, suffix = '') => {
    ed.setValue(suffix);
    ed.setPosition({ lineNumber: 1, column: 1 });
    ed.focus();
    for (const ch of text) ed.trigger('keyboard', 'type', { text: ch });
    await sleep(900);
    const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')).slice(0, 4).map(r => r.getAttribute('aria-label'));
    ed.trigger('auto', 'hideSuggestWidget', {});
    return rows;
  };
  out.suggest = {
    afterFrom: await typeAndRead('select * from mst_b'),
    afterAliasDot: await typeAndRead('select b.', ' from mst_biz b'),
    afterWhere: await typeAndRead('select * from mst_biz b where bi'),
    start: await typeAndRead('se'),
  };

  // 회색 미리보기: 방금 실행한 문장이 이력에 (리터럴은 ?) 있다
  ed.setValue('select g as');
  ed.setPosition({ lineNumber: 1, column: 12 });
  ed.trigger('auto', 'editor.action.inlineSuggest.trigger', {});
  await sleep(1000);
  out.ghost = Array.from(document.querySelectorAll('[class*=ghost-text]')).map(e => e.textContent).join('');

  // ERD 에서 고른 테이블로 SELECT 만들어 실행
  const join = buildJoinSelect(model.value!, ['mst_biz_wh', 'mst_biz', 'mst_wh']);
  ed.setValue(join);
  ed.setSelection(ed.getModel()!.getFullModelRange());
  const jr = await tab.run();
  out.join = { sql: join, columns: jr?.columns.length, error: tab.state() ? undefined : 'no state' };
  ed.setPosition({ lineNumber: 1, column: 1 });

  // 아래 터미널 영역: PowerShell 에서 claude --version, 한글 폭, 시작 폴더(사용자 홈)
  const tid = await addTerm('powershell');
  await nextTick(); await sleep(3000);
  const term = terminals.value!.get(tid)!;
  term.write('claude --version\r');
  await sleep(8000);
  term.write('echo 가나다ABC\r');
  await sleep(500);
  term.write('(Get-Location).Path\r');
  await sleep(1500);
  const buf = term.bufferText();
  out.terminal = { claude: /\(Claude Code\)/.test(buf), korean: buf.includes('가나다ABC'), tail: buf.split('\n').slice(-6),
    tabTitle: terminals.value!.terms.find(t => t.id === tid)?.title };
  // 실행 중에 터미널 하나를 닫아도 오류가 없어야 한다
  const t2 = await addTerm('bash');
  await sleep(2500);
  terminals.value!.close(t2);
  terminals.value!.activate(tid);
  await sleep(1500);
  // 위(ERD)와 아래(터미널)가 같이 보이는지: 두 영역의 화면 위치
  activeTab.value = 'erd';
  await nextTick(); await frames(5);
  const top = document.querySelector('.main-top')?.getBoundingClientRect();
  const bottom = document.querySelector('.term-panel')?.getBoundingClientRect();
  out.layout = { topHeight: Math.round(top?.height ?? 0), bottomTop: Math.round(bottom?.top ?? 0), bottomHeight: Math.round(bottom?.height ?? 0) };
  out.tabs = { sql: id, erd: 'erd' };
  activeTab.value = id;
  return JSON.parse(JSON.stringify(out)); // 반응형 값이 섞여 있어 평범한 값으로 바꿔 돌려준다
}

// ERD 보기 시험용 (메인이 실제 마우스 입력과 함께 부른다)
window.__erdView = async (opts: { mode?: 'grid' | 'tree'; edge?: ViewState['edgeKind'] }) => {
  if (opts.mode) setArrangeMode(opts.mode);
  if (opts.edge) view.edgeKind = opts.edge;
  await nextTick(); await frames(10); await sleep(600);
  // 겹치는 테이블 쌍 수 (화면 위치 기준)
  const boxes = Array.from(document.querySelectorAll('.pane.canvas .split > .pane:first-child .vue-flow__node-table'))
    .map(e => e.getBoundingClientRect());
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++;
  }
  return { mode: diagram.value && arrangeMode(diagram.value), edge: view.edgeKind, tables: boxes.length, overlaps };
};
/** 본 ERD 에서 이름으로 테이블 노드 화면 위치 (머리 부분). 먼저 그 테이블로 화면을 옮긴다 */
window.__erdNodeRect = async (name: string) => {
  await canvas.value?.focusTable(name);
  await sleep(600);
  const node = Array.from(document.querySelectorAll('.pane.canvas .split > .pane:first-child .vue-flow__node-table'))
    .find(e => e.querySelector('.head b')?.textContent === name);
  const r = node?.querySelector('.head')?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
};
window.__erdInspect = () => ({
  selected: Array.from(document.querySelectorAll('.vue-flow__node-table.selected .head b')).map(e => e.textContent),
  selectedOutline: getComputedStyle(document.querySelector('.vue-flow__node-table.selected .tbl') ?? document.body).outlineWidth,
  mini: miniName.value,
  miniTables: Array.from(document.querySelectorAll('.mini .vue-flow__node-table .head b')).map(e => e.textContent).sort(),
  expected: miniModel.value?.tables.map(t => t.name).sort() ?? [],
  badges: { pk: document.querySelectorAll('.key .pk').length, fk: document.querySelectorAll('.key .fk').length, nn: document.querySelectorAll('.key .nn').length },
});
window.__erdGrid = () => {
  const row = document.querySelector('.ag-row');
  const cell = document.querySelector('.ag-cell');
  const body = document.querySelector('.ag-body-viewport');
  return { rowHeight: row?.getBoundingClientRect().height, fontSize: cell ? getComputedStyle(cell).fontSize : null,
    visibleRows: body && row ? Math.floor(body.clientHeight / row.getBoundingClientRect().height) : null };
};

/** STEP 5 시험: DB 비교(dev 대 test), ERD 차이를 dev 에 적용(전체 실행) 후 롤백 */
async function step5Scenario(beDir: string, dir: string) {
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  await openModel(dir);
  const out: Record<string, unknown> = {};

  openCompare();
  await nextTick(); await frames(5);
  compare.value!.setLeft('be:dev');
  compare.value!.setRight('be:test');
  await sleep(300);
  out.devVsTest = await compare.value!.compare();
  await nextTick(); await frames(5); await sleep(300);

  // ERD 에만 컬럼 하나를 더한다 (화면 모델만, 파일 저장 안 함) → dev 와 비교 → dev 에 적용 → 전체 실행 → 롤백
  const original = model.value!;
  const probe = 'erd_tool_probe';
  model.value = { ...original, tables: original.tables.map(t => t.name === 'mst_biz' ? { ...t, columns: [...t.columns, { name: probe, type: 'varchar(10)', notNull: false }] } : t) };
  compare.value!.setRight('be:dev');
  compare.value!.setLeft('be:dev');
  await sleep(200);
  // 왼쪽 dev, 오른쪽 지금 ERD
  compare.value!.setRightErd();
  out.devVsErd = await compare.value!.compare();
  out.alter = compare.value!.alter().split('\n').filter(l => l && !l.startsWith('--'));
  const before = tabs.value.length;
  compare.value!.apply();
  await nextTick(); await frames(5); await sleep(2500); // 새 SQL 탭이 dev 에 접속
  const sqlTab = tabs.value[before];
  const tab = tabRefs.get(sqlTab.id) as InstanceType<typeof SqlTab>;
  out.applyTab = { title: sqlTab.title, conn: sqlTab.initialConn, state: tab.state() };
  out.runAll = await tab.runAll();
  out.afterRun = tab.state();
  const check = await window.erd.sql.run(sqlTab.id, `select ${probe} from mst_biz limit 0`);
  out.columnExistsInTx = !check.error;
  await tab.tx('rollback');
  const after = await window.erd.sql.run(sqlTab.id, `select ${probe} from mst_biz limit 0`);
  out.columnGoneAfterRollback = !!after.error && /does not exist/.test(after.error.message);
  await tab.tx('rollback');
  model.value = original;
  activeTab.value = sqlTab.id;
  out.tabs = { apply: sqlTab.id };
  return JSON.parse(JSON.stringify(out));
}

/**
 * STEP 6 시험 (완료 기준): 화면에서 새 테이블에 컬럼을 추가하고 FK 를 만든 뒤 dev 에 적용(커밋)하고 다시 불러오면 차이 0.
 * 끝에 되돌리기로 수정 전 모델로 돌아가 같은 길로 dev 에 적용(커밋)해 시험 테이블을 지우고, dev 가 수정 전과 같은지 다시 본다.
 * 기존 테이블은 건드리지 않고 시험 테이블(mst_erd_probe)만 만들었다 지운다. 모델 파일은 저장하지 않는다.
 */
async function step6Scenario(beDir: string, dir: string) {
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  await openModel(dir);
  const out: Record<string, unknown> = {};
  const devRef = { source: 'be' as const, beDir, name: 'dev' };
  const diffDev = async () => diffModels((await window.erd.db.read(devRef)).model, model.value!).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}`);
  const original = model.value!;
  out.before = await diffDev(); // 모델 폴더와 dev 가 처음부터 같아야 시험이 뜻이 있다
  const probe = 'mst_erd_probe';

  /** 지금 ERD 를 dev 에 적용: 「DB 에 적용」 → 비교 탭 「왼쪽 DB 에 적용」 → 새 SQL 탭 「전체 실행」 → 커밋 */
  const applyAndCommit = async () => {
    activeTab.value = 'erd';
    await applyToDb();
    const items = compare.value!.items().map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}`);
    const before = tabs.value.length;
    compare.value!.apply();
    await nextTick(); await frames(5); await sleep(2500); // 새 SQL 탭이 dev 에 접속
    const t = tabs.value[before];
    const tab = tabRefs.get(t.id) as InstanceType<typeof SqlTab>;
    const run = await tab.runAll();
    await tab.tx('commit');
    return { items, tab: t.id, run, after: tab.state() };
  };

  try {
    activeTab.value = 'erd';
    await newTable();
    await nextTick(); await frames(5);
    const tempName = editName.value;
    edit(m => updateTable(m, tempName, { name: probe, comment: 'ERD 도구 시험' }));
    await nextTick(); await frames(3);
    editor.value!.addColumnDraft({ name: 'probe_seq', type: 'int', pk: true, comment: '시험 SEQ' });
    await nextTick();
    editor.value!.addColumnDraft({ name: 'biz_seq', type: 'integer', comment: '사업장' });
    await nextTick();
    editor.value!.addFkDraft('mst_biz', ['biz_seq']);
    await nextTick(); await frames(10); await sleep(800);
    const t = model.value!.tables.find(x => x.name === probe)!;
    out.edited = { tempName, editor: editName.value, columns: t.columns.map(c => `${c.name} ${c.type}${c.notNull ? ' NN' : ''}`), pk: t.pk, fks: t.fks,
      node: Array.from(document.querySelectorAll('.vue-flow__node-table .head b')).some(e => e.textContent === probe),
      edge: !!document.querySelector(`.vue-flow__edge[data-id="${t.id}:${t.fks[0]?.name}"]`), canUndo: canUndo.value, message: message.value };
    // 잘못된 수정은 막히고 모델은 그대로
    const bad = edit(m => updateTable(m, probe, { name: 'mst_biz' }));
    out.badEdit = { applied: bad, message: message.value };
    out.apply = await applyAndCommit();
    out.afterApply = await diffDev(); // 다시 불러오면 차이 0 (완료 기준)
  } finally {
    // 되돌리기로 수정 전 모델로 → 같은 길로 dev 에 적용해 시험 테이블을 지운다
    let undos = 0;
    while (canUndo.value) { undo(); undos++; }
    out.undo = { undos, sameAsOriginal: model.value === original };
    out.cleanup = await applyAndCommit();
    out.afterCleanup = await diffDev();
    activeTab.value = 'erd';
  }
  return JSON.parse(JSON.stringify(out));
}

/** STEP 6 화면 캡처용: 되돌린 수정을 다시 하기로 되살려 편집 패널과 함께 보여준다 (DB 는 건드리지 않는다) */
window.__erdStep6Shot = async () => {
  let redos = 0;
  while (canRedo.value) { redo(); redos++; }
  activeTab.value = 'erd';
  openEditor('mst_erd_probe');
  await nextTick(); await frames(5);
  await canvas.value?.focusTable('mst_erd_probe');
  await frames(10); await sleep(800);
  return { redos, editor: editName.value };
};

/**
 * STEP 7 시험: ERD 를 고친 뒤 dev 와 비교해 Flyway 파일과 이력 한 줄을 만들고, MD 문서와 메뉴 물리 테이블 목록을 만든다.
 * 파일은 모두 exportDir(시험용 임시 폴더)에 쓴다. BE 의 db/migration 은 다음 번호만 읽는다. DB 는 읽기만 한다.
 */
async function step7Scenario(beDir: string, dir: string, exportDir: string) {
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  await openModel(dir);
  const out: Record<string, unknown> = {};
  activeTab.value = 'erd';
  out.arrange = await window.__erdView!({}); // 배치 방식이 적혀 있지 않은 모델은 트리로 열린다
  const probe = 'mst_erd_probe';
  edit(m => addTable(m, probe, { comment: 'ERD 도구 시험', withCommon: true }));
  edit(m => addColumn(m, probe, { name: 'probe_seq', type: 'int', notNull: false, pk: true }));
  edit(m => addColumn(m, probe, { name: 'biz_seq', type: 'integer', notNull: false, comment: '사업장' }));
  edit(m => addFk(m, probe, { name: 'fk_mst_erd_probe_mst_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] }));

  // Flyway: 왼쪽 dev, 오른쪽 지금 ERD
  await applyToDb();
  out.compare = compare.value!.items().map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}`);
  out.beNextVersion = await window.erd.export.nextVersion(`${beDir}/src/main/resource/db/migration`);
  compare.value!.setFlyway({ menuCode: 'menu01' });
  const f1 = await compare.value!.writeFlyway(`${exportDir}/migration`, `${exportDir}/99-migration-history.md`);
  const f2 = await compare.value!.writeFlyway(`${exportDir}/migration`); // 같은 폴더에 다시: 번호가 올라간다
  out.flyway = { first: f1 && { fileName: f1.fileName, history: !!f1.history, statements: f1.statements }, second: f2?.fileName };
  await nextTick(); await frames(5);

  // MD: 스키마 문서, 다시 쓰면 같은 이름을 덮어쓴다, 메뉴 물리 테이블 목록
  openExport();
  await nextTick(); await frames(5);
  const md = await exporter.value!.writeSchema(`${exportDir}/md`);
  const again = await exporter.value!.writeSchema(`${exportDir}/md`);
  const menu = await exporter.value!.writeMenu(`${exportDir}/md`, 'MENU01', ['mst_biz', probe]);
  out.md = { files: md.map(p => p.split(/[\\/]/).pop()), againWritten: again.length, menu: menu.map(p => p.split(/[\\/]/).pop()),
    error: document.querySelector('.export .warn')?.textContent ?? '' };

  while (canUndo.value) undo();
  out.undone = model.value!.tables.every(t => t.name !== probe);
  return JSON.parse(JSON.stringify(out));
}

/**
 * STEP 8 시험 (완료 기준): 내장 터미널에서 실제 Claude Code 에 「mst_biz_wh 에 sort_no 컬럼 추가하고 mst_biz_center 옆에 둬」 라고 하면
 * ERD 에 강조된 변경이 나타나고 다른 테이블 위치는 바뀌지 않는다. 모델 파일은 저장하지 않는다(메인이 캡처 뒤 취소한다).
 * prompt 를 주면 그 문장으로, measure 면 토큰 측정용 짧은 요청 두 개(도구 부름, 안 부름)를 json 출력으로 돌린다.
 */
async function step8Scenario(beDir: string, dir: string, exportDir: string, measure: boolean) {
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  await openModel(dir);
  activeTab.value = 'erd';
  await nextTick(); await frames(10); await sleep(800);
  const out: Record<string, unknown> = {};
  const before = canvas.value!.boxes();
  const info = await window.erd.mcp.info();
  out.mcp = info ? { url: info.url } : null;
  if (!info) return out;

  const tid = await addTerm('powershell');
  await nextTick(); await sleep(3000);
  const term = terminals.value!.get(tid)!;
  /** 터미널에 명령을 치고 끝 표시가 나올 때까지 기다린다. 입력 줄에는 끝 표시 글자가 그대로 나오지 않게 둘로 나눠 친다 */
  const run = async (cmd: string, limitMs: number) => {
    const mark = `ERD_DONE_${Math.random().toString(36).slice(2, 8)}`;
    term.write(`${cmd}; echo ("${mark.slice(0, 5)}" + "${mark.slice(5)}")\r`);
    const t0 = Date.now();
    while (Date.now() - t0 < limitMs) {
      await sleep(1000);
      if (term.bufferText().split('\n').some(l => l.trim() === mark)) return Math.round((Date.now() - t0) / 1000);
    }
    return -1;
  };
  const claude = (prompt: string, extra = '') =>
    `claude -p "${prompt}" --mcp-config "${info.claudeConfig}" --strict-mcp-config --allowedTools "mcp__erd__*" ${extra}`;

  // 토큰 측정: erd_overview 를 부를 때와 안 부를 때 입력 토큰 차이 (대략값)
  if (measure) {
    const a = `${exportDir}/with-overview.json`.replace(/\\/g, '/'), b = `${exportDir}/without.json`.replace(/\\/g, '/');
    out.measure = {
      withOverview: await run(claude('erd_overview 도구를 한 번 부르고, 그 결과의 줄 수만 숫자로 답해', `--output-format json | Out-File -Encoding utf8 "${a}"`), 180_000),
      without: await run(claude('도구를 부르지 말고 0 이라고만 답해', `--output-format json | Out-File -Encoding utf8 "${b}"`), 180_000),
      overviewChars: overview(model.value!).length,
    };
    return JSON.parse(JSON.stringify(out)); // 측정만 한다 (완료 기준 문장은 다시 돌리지 않는다)
  }

  const prompt = 'mst_biz_wh 에 sort_no 컬럼 추가하고 mst_biz_center 옆에 둬';
  out.claudeSeconds = await run(claude(prompt), 300_000);
  await nextTick(); await frames(10); await sleep(1000);
  const m = model.value!;
  const wh = m.tables.find(t => t.name === 'mst_biz_wh')!;
  const center = m.tables.find(t => t.name === 'mst_biz_center')!;
  const after = canvas.value!.boxes();
  const moved = [...before].filter(([id, b]) => id !== wh.id && (after.get(id)?.x !== b.x || after.get(id)?.y !== b.y)).map(([id]) => nameOf(id));
  const c = after.get(center.id)!, w = after.get(wh.id)!;
  out.result = {
    sortNo: wh.columns.find(x => x.name === 'sort_no') ?? null,
    pinned: diagram.value!.pinned[wh.id] ?? null,
    whBox: w, centerBox: c,
    besideCenter: w.x >= c.x + c.w && w.x - (c.x + c.w) < 400 && Math.abs(w.y - c.y) < 600,
    otherTablesMoved: moved.length, movedNames: moved.slice(0, 10), totalTables: before.size,
    highlighted: [...aiChanged.value].map(nameOf), highlightDom: document.querySelectorAll('.vue-flow__node-table .tbl.ai').length,
    banner: document.querySelector('.ai-bar')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    saveDisabled: (document.querySelector('header button:nth-of-type(2)') as HTMLButtonElement | null)?.disabled ?? null,
  };
  out.terminalTail = term.bufferText().split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-12);
  await canvas.value!.focusTable('mst_biz_wh');
  return JSON.parse(JSON.stringify(out));
}
/** STEP 8 시험 끝: 확정 대기를 취소해 원래 모델로 (저장하지 않음) */
window.__erdAiCancel = () => { aiCancel(); return { pending: !!aiBase.value, tables: model.value?.tables.length, sortNo: !!model.value?.tables.find(t => t.name === 'mst_biz_wh')?.columns.some(c => c.name === 'sort_no') }; };

/**
 * 비밀번호 창 시험: beDir 은 비밀번호를 자동으로 풀 수 없는 시험용 BE 폴더다.
 * 접속 시험 → 「자동으로 풀지 못했다」 창 → 틀린 비밀번호 → DB 거부 → 「틀렸다」 창 → 취소 → 접속 시험 결과에 취소가 나온다.
 */
async function passwordScenario(beDir: string) {
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  const waitAsk = async () => { for (let i = 0; i < 100 && !pwAsk.value; i++) await sleep(100); return pwAsk.value ? { ...pwAsk.value } : null; };
  const out: Record<string, unknown> = {};
  const result = window.erd.conn.test({ source: 'be', beDir, name: 'dev' });
  const first = await waitAsk();
  out.first = first && { label: first.label, reason: first.reason, dialog: !!document.querySelector('.modal input[type=password]') };
  pwInput.value = { password: 'erd-tool-wrong-password', save: false };
  answerPw(true);
  await sleep(300);
  const second = await waitAsk();
  out.second = second && { reason: second.reason };
  answerPw(false);
  out.result = await result;
  out.dialogClosed = !pwAsk.value;
  return JSON.parse(JSON.stringify(out));
}

window.__erdAuto = async ({ scenario, beDir, profile, modelDir: dir, exportDir, measure }) => {
  if (scenario === 'password') return passwordScenario(beDir);
  if (scenario === 'mcp') { // 시험용: 모델을 열고 기다린다. 그동안 밖에서 MCP 도구를 직접 부른다 (mcp-erd.json 의 주소와 토큰)
    await panel.value!.setSource('be'); await panel.value!.setBeDir(beDir); await openModel(dir);
    await sleep(Number(measure) || 60_000);
    return { tables: model.value?.tables.length };
  }
  if (scenario === 'step8') return step8Scenario(beDir, dir, exportDir!, !!measure);
  if (scenario === 'step7') return step7Scenario(beDir, dir, exportDir!);
  if (scenario === 'step6') return step6Scenario(beDir, dir);
  if (scenario === 'step5') return step5Scenario(beDir, dir);
  if (scenario === 'sql') return sqlScenario(beDir, dir);
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  await setModelDir(dir);
  panel.value!.select(profile);
  await panel.value!.doReverse();
  const r = panel.value!.pending;
  if (!r) throw new Error('리버스 결과가 없다');
  const summary = { counts: r.counts, tables: r.model.tables.length, fks: r.model.tables.reduce((n, t) => n + t.fks.length, 0),
    functions: r.model.functions.length, sequences: r.model.sequences.length, warnings: r.warnings, hadModel: r.hadModel,
    diff: { added: r.diff.added.length, removed: r.diff.removed.length, changed: r.diff.changed.length } };
  panel.value!.apply();
  const saved = await save();
  await nextTick(); await frames(10); await new Promise(res => setTimeout(res, 1500));
  // 보기 모드마다 글자가 잘린 칸(이름, 논리명, 타입) 수를 센다
  const truncated: Record<string, number> = {};
  for (const mode of ['both', 'physical', 'logical'] as const) {
    view.nameMode = mode; await nextTick(); await frames(3);
    truncated[mode] = Array.from(document.querySelectorAll('.vue-flow__node-table .row > span, .vue-flow__node-table .head > *'))
      .filter(e => e.scrollWidth > e.clientWidth + 1).length;
  }
  view.nameMode = 'both'; await nextTick(); await frames(3);
  const drawn = { tableNodes: document.querySelectorAll('.vue-flow__node-table').length, edges: document.querySelectorAll('.vue-flow__edge').length, truncated };
  return { summary, saved: { written: saved?.written.length, unchanged: saved?.unchanged.length, removed: saved?.removed.length }, drawn };
};
// 화면 캡처 뒤 메인이 부른다: 기본 설정(컬럼 숨김 끔)으로 성능 측정
window.__erdBench = async () => {
  const result = await canvas.value!.bench(4000, [0.15, 1.0]);
  await canvas.value!.fitView();
  return result;
};
</script>

<template>
  <div class="app">
    <header>
      <button @click="openModel()">모델 폴더 열기</button>
      <button :disabled="!model || !!aiBase" :title="aiBase ? 'AI 변경을 확정하거나 취소한 뒤 저장한다' : ''" @click="save">저장{{ dirty ? ' *' : '' }}</button>
      <button :disabled="!model" title="새 테이블을 만들고 편집 패널을 연다" @click="newTable">테이블 추가</button>
      <button :disabled="!canUndo" title="Ctrl+Z" @click="undo">되돌리기</button>
      <button :disabled="!canRedo" title="Ctrl+Y" @click="redo">다시 하기</button>
      <button :disabled="!model" title="모델 전체 CREATE 문을 새 SQL 탭에 넣는다" @click="createAll">전체 CREATE</button>
      <button :disabled="!model" title="DB 비교 탭에서 지금 ERD 와 DB 를 비교한다. 적용은 그 탭의 「왼쪽 DB 에 적용」으로" @click="applyToDb">DB 에 적용</button>
      <span class="dir" :title="modelDir">{{ modelDir || '모델 폴더 없음' }}</span>
      <span class="spacer" />
      <label>보기
        <select v-model="view.nameMode">
          <option value="physical">물리명</option>
          <option value="logical">논리명</option>
          <option value="both">둘 다</option>
        </select>
      </label>
      <label>선
        <select v-model="view.edgeKind">
          <option value="smoothstep">꺾은선</option>
          <option value="straight">직선</option>
          <option value="default">곡선</option>
        </select>
      </label>
      <label>정렬
        <select :value="diagram ? arrangeMode(diagram) : 'tree'" :disabled="!model" @change="e => setArrangeMode((e.target as HTMLSelectElement).value as 'grid' | 'tree')">
          <option value="tree">트리 (FK 부모 위)</option>
          <option value="grid">그룹 격자</option>
        </select>
      </label>
      <button :disabled="!model" title="끌어 옮긴 위치를 지우고 고른 정렬 방식대로 다시 놓는다" @click="autoArrange">자동 정렬</button>
      <label><input v-model="view.compactOnZoomOut" type="checkbox" /> 축소하면 이름만 보기</label>
    </header>
    <div class="body">
      <!-- 왼쪽 접속 패널 | 오른쪽(위: ERD, SQL 탭 / 아래: 터미널). 경계선을 끌어 크기를 바꾼다 -->
      <SplitPane dir="row" fixed="first" :initial="300" :min="200" :max="700" storage-key="left">
        <template #first>
          <ConnPanel ref="panel" :model-dir="modelDir" @apply="applyReverse" @be-dir="onBeDir" />
        </template>
        <template #second>
          <SplitPane dir="col" fixed="second" :initial="280" :min="100" storage-key="terminal" :hide-fixed="!termVisible">
            <template #first>
              <main class="main main-top">
                <nav class="tabs">
                  <button v-for="t in tabs" :key="t.id" :class="{ on: t.id === activeTab }" @click="activeTab = t.id">
                    {{ t.title }}<b v-if="t.dirty" class="warn"> *</b>
                    <span v-if="t.kind !== 'erd'" class="x" title="닫기" @click.stop="closeTab(t)">×</span>
                  </button>
                  <button class="add" @click="addSql()">+ SQL</button>
                  <button class="add" @click="openCompare">DB 비교</button>
                  <button class="add" title="MD 문서, 메뉴 물리 테이블 목록. Flyway 파일은 DB 비교 탭에서" @click="openExport">내보내기</button>
                  <button v-if="selected.length" class="add" @click="addSql(buildJoinSelect(model!, selected))">SELECT 만들기 ({{ selected.length }})</button>
                  <button v-if="selected.length === 1" class="add" @click="openEditor(selected[0])">테이블 편집</button>
                  <span class="spacer" />
                  <button class="add" title="Ctrl+`" @click="toggleTerm">{{ termVisible ? '터미널 숨기기 ▾' : '터미널 ▴' }}</button>
                </nav>
                <div v-show="activeTab === 'erd'" class="pane canvas">
                  <div v-if="aiBase" class="ai-bar">
                    AI 변경 <b>{{ aiChanged.size }}</b>개 테이블 확정 대기 (주황 테두리)
                    <button @click="aiConfirm">확정</button>
                    <button @click="aiCancel">취소</button>
                  </div>
                  <!-- 테이블을 더블클릭하면 오른쪽에 미니 ERD 가 열린다 (그 테이블과 FK 로 바로 이어진 테이블만) -->
                  <SplitPane dir="row" fixed="second" :initial="560" :min="260" storage-key="mini" :hide-fixed="!miniName && !editName">
                    <template #first>
                      <ErdCanvas v-if="model && diagram" ref="canvas" :model="model" :diagram="diagram" :version="version" :fit-key="fitKey" :highlight="aiChanged"
                                 @pin="onPin" @select="n => (selected = n)" @open="n => { editId = ''; miniName = n; }" />
                      <p v-else class="empty">왼쪽에서 DB 를 불러오거나, 위에서 모델 폴더를 여세요.</p>
                    </template>
                    <template #second>
                      <TableEditor v-if="model && editName" ref="editor" :model="model" :name="editName" @edit="edit" @close="editId = ''" />
                      <section v-else-if="model && miniName" class="mini">
                        <header>
                          <b>{{ miniName }}</b>
                          <span class="muted">와 바로 이어진 테이블 {{ miniModel!.tables.length - 1 }}개, 더블클릭하면 그 테이블 기준으로 바뀐다</span>
                          <span class="spacer" />
                          <button title="닫기" @click="miniName = ''">×</button>
                        </header>
                        <div class="mini-body">
                          <ErdCanvas ref="mini" flow-id="mini" :model="miniModel!" :diagram="miniDiagram" :version="version"
                                     :focus="miniName" :show-mini-map="false" fit-on-resize @open="n => (miniName = n)" />
                        </div>
                      </section>
                    </template>
                  </SplitPane>
                </div>
                <div v-for="t in tabs.filter(x => x.kind === 'sql')" v-show="activeTab === t.id" :key="t.id" class="pane">
                  <SqlTab :ref="el => setTabRef(t.id, el)" :tab-id="t.id" :schema="model" :initial-sql="t.initialSql" :initial-conn="t.initialConn"
                          :active="activeTab === t.id" @state="s => (t.dirty = !!s?.dirty)" />
                </div>
                <div v-if="tabs.some(x => x.kind === 'compare')" v-show="activeTab === 'compare'" class="pane">
                  <CompareTab ref="compare" :model="model" @open-sql="p => addSql(p.sql, p.conn)" />
                </div>
                <div v-if="tabs.some(x => x.kind === 'export')" v-show="activeTab === 'export'" class="pane">
                  <ExportTab ref="exporter" :model="model" :selected="selected" @compare="openCompare" />
                </div>
              </main>
            </template>
            <template #second>
              <TerminalPanel ref="terminals" :visible="termVisible" @hide="termVisible = false" @empty="termVisible = false" />
            </template>
          </SplitPane>
        </template>
      </SplitPane>
    </div>
    <div v-if="pwAsk" class="modal">
      <form class="dialog" @submit.prevent="answerPw(true)">
        <p><b>{{ pwAsk.label }}</b> 비밀번호</p>
        <p class="warn">{{ pwAsk.reason }}</p>
        <input ref="pwBox" v-model="pwInput.password" type="password" autocomplete="off" class="pw" />
        <label class="save"><input v-model="pwInput.save" type="checkbox" /> 이 PC 에 저장 (Windows 계정 암호화, 다음부터 묻지 않음)</label>
        <div class="row">
          <button type="submit" :disabled="!pwInput.password">접속</button>
          <button type="button" @click="answerPw(false)">취소</button>
        </div>
      </form>
    </div>
    <div v-if="closeAsk" class="modal">
      <div class="dialog">
        <p>커밋하지 않은 변경이 있다: <b>{{ closeAsk.labels.join(', ') }}</b></p>
        <div class="row">
          <button @click="answerClose('commit')">커밋하고 닫기</button>
          <button @click="answerClose('rollback')">롤백하고 닫기</button>
          <button @click="answerClose('cancel')">취소</button>
        </div>
      </div>
    </div>
    <footer>
      <span>{{ message }}</span>
      <span v-if="model">테이블 {{ model.tables.length }}, FK {{ model.tables.reduce((n, t) => n + t.fks.length, 0) }}</span>
      <span v-if="errors.length" class="warn" :title="errors.map(e => `${e.file}:${e.line} ${e.message}`).join('\n')">검증 오류 {{ errors.length }}개</span>
    </footer>
  </div>
</template>

<style>
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #6a737d; --line: #d0d7de; --accent: #2f6fb3; --panel-bg: #f6f8fa; --sel-bg: #e7f0fa;
  --node-bg: #ffffff; --node-border: #6b8fb8; --node-head: #dbe7f5; --pk-bg: #fff8d6; --key: #b26b00;
  --group-bg: rgba(47, 111, 179, 0.04); --group-border: #9fb7d3; --edge: #7f93ad; --ok: #1a7f37; --warn: #c62828;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1e1f22; --fg: #d4d7dc; --muted: #8b949e; --line: #3a3d42; --accent: #5ea1e6; --panel-bg: #25272b; --sel-bg: #253446;
    --node-bg: #2a2d31; --node-border: #4f6b8c; --node-head: #2f3d4e; --pk-bg: #3a3420; --key: #e3a64a;
    --group-bg: rgba(94, 161, 230, 0.05); --group-border: #3f5670; --edge: #6d7f96; --ok: #3fb950; --warn: #f47067;
  }
}
html, body, #app { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--fg); font: 13px 'Malgun Gothic', sans-serif; }
.app { height: 100%; display: flex; flex-direction: column; }
header, footer { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); }
header button, header label { white-space: nowrap; }
footer { border-top: 1px solid var(--line); border-bottom: none; font-size: 12px; color: var(--muted); }
.spacer { flex: 1; }
.dir { color: var(--muted); max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.body { flex: 1; display: flex; min-height: 0; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
.tabs { display: flex; gap: 2px; align-items: flex-end; padding: 4px 6px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tabs button { border: 1px solid var(--line); border-bottom: none; background: var(--panel-bg); color: var(--fg); padding: 4px 10px; cursor: pointer; }
.tabs button.on { background: var(--bg); font-weight: bold; border-color: var(--accent); }
.tabs .add { background: transparent; border-style: dashed; }
.tabs .x { margin-left: 6px; color: var(--muted); }
.pane { flex: 1; min-height: 0; position: relative; }
.canvas { position: relative; }
.modal { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
.dialog { background: var(--bg); border: 1px solid var(--line); padding: 16px; max-width: 480px; }
.dialog .row { display: flex; gap: 8px; justify-content: flex-end; }
.dialog .pw { width: 100%; box-sizing: border-box; margin: 4px 0 8px; }
.dialog .save { display: block; margin-bottom: 10px; font-size: 12px; }
.mini { height: 100%; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--bg); }
.ai-bar { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 20; display: flex; gap: 8px; align-items: center;
  background: var(--bg); border: 2px solid #f08c00; padding: 4px 10px; font-size: 12px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2); }
.mini header { border-bottom: 1px solid var(--line); font-size: 12px; }
.mini .muted { color: var(--muted); }
.mini-body { flex: 1; min-height: 0; position: relative; }
.empty { padding: 24px; color: var(--muted); }
.warn { color: var(--warn); }
</style>
