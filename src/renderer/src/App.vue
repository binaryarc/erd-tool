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
import { emptyLayout, type Diagram, type Layout } from '../../shared/model/layout';
import type { ModelError, SchemaModel } from '../../shared/model/types';
import type { ReverseResult, ShellKind } from '../../shared/ipc';
import { VIEW_KEY, loadPref, savePref, type ViewState } from './view';
import { neighborhood } from '../../shared/model/tree';

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
  if (!diagram.value || (diagram.value.mode ?? 'grid') === mode) return;
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
  return { mode: diagram.value?.mode, edge: view.edgeKind, tables: boxes.length, overlaps };
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

  // MD: 스키마 문서, 같은 분 안에 다시 쓰면 거부, 메뉴 물리 테이블 목록
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

window.__erdAuto = async ({ scenario, beDir, profile, modelDir: dir, exportDir }) => {
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
      <button :disabled="!model" @click="save">저장{{ dirty ? ' *' : '' }}</button>
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
        <select :value="diagram?.mode ?? 'grid'" :disabled="!model" @change="e => setArrangeMode((e.target as HTMLSelectElement).value as 'grid' | 'tree')">
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
                  <!-- 테이블을 더블클릭하면 오른쪽에 미니 ERD 가 열린다 (그 테이블과 FK 로 바로 이어진 테이블만) -->
                  <SplitPane dir="row" fixed="second" :initial="560" :min="260" storage-key="mini" :hide-fixed="!miniName && !editName">
                    <template #first>
                      <ErdCanvas v-if="model && diagram" ref="canvas" :model="model" :diagram="diagram" :version="version" :fit-key="fitKey"
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
.mini { height: 100%; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--bg); }
.mini header { border-bottom: 1px solid var(--line); font-size: 12px; }
.mini .muted { color: var(--muted); }
.mini-body { flex: 1; min-height: 0; position: relative; }
.empty { padding: 24px; color: var(--muted); }
.warn { color: var(--warn); }
</style>
