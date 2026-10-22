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
import DiagramTabs from './components/DiagramTabs.vue';
import TablePickDialog from './components/TablePickDialog.vue';
import DomainPanel from './components/DomainPanel.vue';
import { addColumn, addFk, addTable, domainUsage, dropDomain, dropFk, dropTable, pasteColumns, updateTable } from '../../shared/model/edit';
import { applyConnect, planConnect, type ConnectPlan, type End } from '../../shared/model/connect';
import type { Column, FkAction } from '../../shared/model/types';
import { columnText } from '../../shared/model/erd-format';
import { TabError, addMembers, createTab, deleteTab, forgetIds, groupTabs, groupView, newTabName, prefixTabs, pruneMembers, removeMembers, renameTab } from '../../shared/model/group-tabs';
import { buildCreateAll } from '../../shared/sql/create';
import { diffModels } from '../../shared/model/diff';
import { buildJoinSelect } from '../../shared/sql/join';
import { DEFAULT_DIAGRAM, syncLayout } from '../../shared/model/arrange';
import { arrangeMode, emptyLayout, type Diagram, type Layout } from '../../shared/model/layout';
import type { ModelError, SchemaModel } from '../../shared/model/types';
import type { ConnRef, ManualConn, ReverseResult, SavePlan, SessionData, SessionTab, ShellKind } from '../../shared/ipc';
import { VIEW_KEY, colKey, loadPref, savePref, type ViewState } from './view';
import { neighborhood } from '../../shared/model/tree';
import { applyCommands } from '../../shared/ai/commands';
import { findSpotNear } from '../../shared/ai/place';
import { diffText, overview, tablesText, viewStateText } from '../../shared/ai/notation';
import { buildAlter } from '../../shared/sql/alter';
import { buildSchemaDocs } from '../../shared/export/md';
import { buildFlyway, suggestDescription } from '../../shared/export/flyway';
import { loadConnOptions } from './conn-options';
import { docField, docTitle, newDoc, sameDir, type ErdDoc, type Pins, type Snap } from './erd-doc';

const view = reactive<ViewState>({
  nameMode: loadPref('nameMode', 'both', ['physical', 'logical', 'both'] as const),
  // 선 모양 기본값은 직선 (사용자 지정 2026-10-16). 이 PC 에서 고른 적이 있으면 그것을 쓴다
  edgeKind: loadPref('edgeKind', 'straight', ['smoothstep', 'straight', 'default'] as const),
  compactOnZoomOut: false, compact: false, colSel: [],
});
watch(() => view.nameMode, v => savePref('nameMode', v));
watch(() => view.edgeKind, v => savePref('edgeKind', v));
provide(VIEW_KEY, view);

// ---------- ERD 탭 (STEP 10 결정 20) ----------
// 위 탭줄에 ERD 탭을 여러 개 연다. 탭마다 화면 상태(erd-doc.ts)가 따로고, 아래 값들은 지금 ERD 탭(cur)의 값을 가리킨다.
// SQL, 비교 탭을 보고 있을 때 cur 는 마지막으로 본 ERD 탭이다 (머리 버튼, 비교, 내보내기, SQL 자동완성이 그 모델을 쓴다).
const docs = new Map<string, ErdDoc>([['erd', newDoc('erd')]]);
const cur = shallowRef<ErdDoc>(docs.get('erd')!);
const modelDir = docField(cur, 'modelDir');
const model = docField(cur, 'model');
const layout = docField(cur, 'layout');
const diagram = docField(cur, 'diagram');
const version = docField(cur, 'version');
const errors = docField(cur, 'errors');
const dirty = docField(cur, 'dirty');
/** 본 ERD 를 전체 보기로 맞추는 때: 모델을 불러올 때만 (고칠 때마다 화면이 튀지 않게) */
const fitKey = docField(cur, 'fitKey');
const message = ref('');
const NL = '\n';
const panel = ref<InstanceType<typeof ConnPanel>>();
const canvas = ref<InstanceType<typeof ErdCanvas>>();

// ---------- 그룹 탭 (STEP 10) ----------
// 보이는 다이어그램 이름. 「전체」 는 모델 전체, 그룹 탭은 소속 테이블만 거른 모델을 캔버스에 넘긴다.
// 수정 명령은 항상 전체 모델에 적용하고, 그룹 탭 화면은 그 결과를 다시 거른다.
const tab = docField(cur, 'tab');
const tabNames = computed(() => { void version.value; return groupTabs(layout.value); });
const membersOf = (name: string) => layout.value.diagrams[name]?.members;
/** 캔버스에 넘길 모델과 그리지 않은 FK (그룹 탭일 때) */
const shown = computed(() => {
  void version.value;
  const m = model.value;
  if (!m) return null;
  const mem = membersOf(tab.value);
  return mem ? groupView(m, mem) : { model: m, external: undefined };
});
/** 보이는 다이어그램을 모델에 맞춘다 (그룹 탭이면 소속 테이블만 넘겨 그 탭의 위치를 맞춘다) */
function refreshDiagram() {
  const m = model.value;
  if (!m) return;
  const mem = membersOf(tab.value);
  diagram.value = syncLayout(mem ? groupView(m, mem).model : m, layout.value, tab.value);
}

function show(m: SchemaModel, l: Layout) {
  model.value = m;
  layout.value = l;
  pruneMembers(l, m);
  if (!membersOf(tab.value)) tab.value = DEFAULT_DIAGRAM;
  refreshDiagram();
  version.value++;
  fitKey.value++;
  history.clear();
  syncHistory();
  aiBase.value = null;
  aiStepsOf().length = 0;
}

// ---------- ERD 수정 (STEP 6) ----------
// 수정 명령(shared/model/edit.ts)은 새 모델을 돌려준다. 되돌리기는 수정 직전 모델과 배치를 기록해 두고 바꿔 끼운다.
// 배치(끌어 옮긴 위치, 정렬 방식, 그룹 탭)도 되돌린다 (STEP 10, 사용자 요청). 배치는 그 자리에서 고쳐 쓰므로 복사해 담는다
const snapNow = (m = model.value!): Snap => ({ model: m, layout: structuredClone(layout.value) });
const history = {
  /** 수정 직전 모델 (배치는 지금 것을 복사해 함께 담는다) */
  push: (m: SchemaModel) => { cur.value.history.push(snapNow(m)); },
  pushSnap: (s: Snap) => { cur.value.history.push(s); syncHistory(); },
  undo: (m: SchemaModel) => cur.value.history.undo(snapNow(m)),
  redo: (m: SchemaModel) => cur.value.history.redo(snapNow(m)),
  clear: () => cur.value.history.clear(),
  get canUndo() { return cur.value.history.canUndo; },
  get canRedo() { return cur.value.history.canRedo; },
};
const canUndo = docField(cur, 'canUndo');
const canRedo = docField(cur, 'canRedo');
function syncHistory() { canUndo.value = history.canUndo; canRedo.value = history.canRedo; }

/** 편집 패널에 띄운 테이블 ID. 이름이 아니라 ID 로 들고 있어야 이름을 바꾸거나 되돌려도 패널이 따라간다 */
const editId = docField(cur, 'editId');
const editName = computed(() => model.value?.tables.find(t => t.id === editId.value)?.name ?? '');

function setModel(m: SchemaModel) {
  model.value = m;
  refreshDiagram();
  version.value++;
  dirty.value = true;
  syncHistory();
  if (miniName.value && !m.tables.some(t => t.name === miniName.value)) miniName.value = '';
}

function edit(fn: (m: SchemaModel) => SchemaModel, done?: (ok: boolean) => void, note?: string): boolean {
  if (!model.value) { done?.(false); return false; }
  let next: SchemaModel;
  try { next = fn(model.value); }
  catch (e) { message.value = `수정하지 못했습니다: ${(e as Error).message}`; done?.(false); return false; }
  if (next !== model.value) {
    history.push(model.value);
    setModel(next);
    message.value = note ?? '수정했습니다 (저장 전)';
  }
  done?.(true);
  return true;
}

/** 되돌리기 한 칸을 화면에 놓는다. 보던 그룹 탭이 없어졌으면 「전체」 로 */
function restore(s: Snap) {
  layout.value = s.layout;
  if (!membersOf(tab.value)) tab.value = DEFAULT_DIAGRAM;
  setModel(s.model);
}
function undo() {
  const s = model.value && history.undo(model.value);
  if (s) { restore(s); message.value = '되돌렸습니다'; }
}
function redo() {
  const s = model.value && history.redo(model.value);
  if (s) { restore(s); message.value = '다시 실행했습니다'; }
}

function openEditor(name: string) {
  const t = model.value?.tables.find(x => x.name === name);
  if (!t) return;
  miniName.value = '';
  editId.value = t.id;
  pickId.value = t.id;
}

/** Enter 로 컬럼을 더할 테이블 ID: 마지막으로 하나만 고른 테이블이나 편집 패널에 연 테이블 중 나중 것 (STEP 10).
 *  새 테이블을 만든 직후 캔버스에 다른 테이블이 골라져 있어도 새 테이블로 간다 */
const pickId = docField(cur, 'pickId');
function onSelect(names: string[]) {
  selected.value = names;
  pickId.value = names.length === 1 ? (model.value?.tables.find(t => t.name === names[0])?.id ?? '') : names.length ? '' : editId.value;
}

/** 새 테이블: 겹치지 않는 임시 이름으로 만들고 편집 패널을 연다. 공통 컬럼(reg_id 등)이 정의돼 있으면 넣는다 */
async function newTable() {
  if (!model.value) return;
  const names = new Set(model.value.tables.map(t => t.name));
  let name = 'new_table';
  for (let i = 2; names.has(name); i++) name = `new_table_${i}`;
  if (!edit(m => addTable(m, name, { withCommon: m.common.length > 0 }))) return;
  // 그룹 탭에서 만들면 그 그룹에도 넣는다. 지운 테이블의 ID 가 다시 쓰였을 수 있어 다른 그룹 소속에서는 먼저 뺀다
  const id = model.value.tables.find(t => t.name === name)!.id;
  forgetIds(layout.value, [id]);
  if (membersOf(tab.value)) addMembers(layout.value, tab.value, [id]);
  refreshDiagram();
  version.value++;
  openEditor(name);
  await nextTick();
  await canvas.value?.focusTable(name);
}

/** Enter 로 컬럼 추가 (STEP 10): 편집 패널을 열고 column_N 을 더해 그 이름 칸에 포커스 */
async function enterColumn(name: string): Promise<string | undefined> {
  if (editName.value !== name) openEditor(name);
  await nextTick();
  return editor.value?.addNext();
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
const aiBase = docField(cur, 'aiBase');
/** 지금 ERD 탭의 AI 변경 단계 (배열을 그 자리에서 고친다) */
const aiStepsOf = () => cur.value.aiSteps;
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
  // AI 변경은 「전체」 탭에서 보여 준다. 그룹 탭이면 다른 탭에만 있는 테이블의 크기를 찾지 못한다 (STEP 10)
  if (tab.value !== DEFAULT_DIAGRAM) { selectTab(DEFAULT_DIAGRAM); await nextTick(); }
  const before = needModel();
  const beforePinned = pinsNow();
  const r = applyCommands(before, lines); // 실패하면 여기서 끝나고 아무것도 바뀌지 않는다
  history.push(before);
  const oldIds = new Set(before.tables.map(t => t.id));
  forgetIds(layout.value, r.model.tables.filter(t => !oldIds.has(t.id)).map(t => t.id));
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
  aiStepsOf().push({ before, beforePinned, after: model.value! });
  version.value++;
  message.value = 'AI 가 수정했습니다 (확정 대기)';
  return [
    `적용함: 명령 ${r.done.length}줄`,
    ...placed,
    `확정 대기 중인 테이블: ${[...aiChanged.value].map(nameOf).join(', ')}`,
    '화면에 주황 테두리로 강조됐다. 사람이 「확정」해야 모델 파일에 저장된다',
  ].join('\n');
}

function aiUndo(): string {
  const step = aiStepsOf().at(-1);
  if (!step) throw new Error('되돌릴 AI 변경이 없다 (사람이 확정했거나 아직 고치지 않았다)');
  if (model.value !== step.after) throw new Error('그 뒤에 사람이 ERD 를 고쳐서 AI 변경만 되돌릴 수 없다');
  aiStepsOf().pop();
  history.push(model.value);
  setModel(step.before);
  setPins(step.beforePinned);
  if (!aiStepsOf().length) aiBase.value = null;
  return `마지막 erd_apply 를 되돌렸다. 남은 확정 대기 변경: ${aiStepsOf().length}번`;
}

/** 사람의 「확정」: 강조만 푼다 (저장은 「저장」 버튼으로) */
function aiConfirm() {
  aiBase.value = null;
  aiStepsOf().length = 0;
  version.value++;
  message.value = 'AI 변경을 확정했습니다 (저장 전)';
}
/** 사람의 「취소」: AI 가 고치기 전 모습으로 */
function aiCancel() {
  const base = aiBase.value;
  if (!base || !model.value) return;
  history.push(model.value);
  setModel(base.model);
  setPins(base.pinned);
  aiBase.value = null;
  aiStepsOf().length = 0;
  message.value = 'AI 변경을 취소했습니다';
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
  // 고르는 창이 없으므로 없는 폴더에 만들지 않는다: 기억한 폴더, 없으면 BE 에 실제로 있는 db/migration
  const dir = s.exportDirs?.flyway ?? (s.beDir ? await window.erd.export.flywayDir(s.beDir) : null);
  if (!dir) throw new Error('Flyway 폴더를 먼저 고르세요. 사람이 DB 비교 탭에서 Flyway 파일을 한 번 만들면 그 폴더를 기억한다');
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
      else if (tool === 'erd_view_state') { needModel(); text = viewStateText(shown.value!.model, diagram.value!, canvas.value!.boxes(), canvas.value!.zoom(), tab.value); }
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

/** 저장 안 한 ERD 변경(확정 대기 중인 AI 변경 포함)이 있으면 버려도 되는지 묻는다. 없으면 바로 true */
function discardOk(what: string): boolean {
  if (!dirty.value && !aiBase.value) return true;
  return confirm(`저장하지 않은 ERD 변경이 있습니다${aiBase.value ? ' (확정 대기 중인 AI 변경 포함)' : ''}.\n${what} 이 변경은 사라집니다. 계속할까요?`);
}
// X 버튼이 아닌 길(window.close(), 새로 고침)로 화면이 내려가려 하면 막는다. 막으면 메인이 창으로 묻는다(will-prevent-unload).
// X 버튼은 메인이 먼저 묻고 확인하면 여기서 막아도 메인이 통과시킨다.
// 저장 안 한 ERD 변경은 마지막 화면(session.json)에 2초마다 담기므로 막지 않는다 (STEP 10 결정 22)
window.addEventListener('beforeunload', e => {
  if (tabs.value.some(t => t.dirty)) e.returnValue = false;
});

async function openModel(dir?: string) {
  let d = dir;
  if (!d) {
    // 폴더 안 파일이 모두 보이는 창에서 파일 하나를 고르면 그 폴더를 연다 (2026-10-16 사용자 지정)
    const picked = await window.erd.model.pickOpen(modelDir.value || undefined);
    if (!picked) return;
    if (!picked.hasModel) { message.value = `ERD 모델 폴더가 아닙니다 (_index.erd 없음): ${picked.dir}`; return; }
    d = picked.dir;
  }
  // 다른 ERD 탭에 이미 열린 폴더면 그 탭으로 간다 (한 폴더를 두 탭에서 고치면 저장할 때 서로 덮어쓴다)
  const other = [...docs.values()].find(x => x !== cur.value && sameDir(x.modelDir.value, d) && x.model.value);
  if (other) { activeTab.value = other.id; message.value = `이미 ${titleOf(other.id)} 탭에 열려 있어 그 탭으로 이동했습니다`; return; }
  if (!discardOk('다른 ERD 를 열면')) return;
  await setModelDir(d);
  const r = await window.erd.model.load(d);
  errors.value = r.errors;
  show(r.model, r.layout);
  dirty.value = false;
  message.value = `불러왔습니다: 테이블 ${r.model.tables.length}개`;
}

function applyReverse(r: ReverseResult) {
  errors.value = [];
  // 모델 폴더의 기존 배치를 쓴다 (화면에 띄운 배치가 아니라). 끌어 옮긴 위치를 지키기 위해서다
  show(r.model, r.layout);
  dirty.value = true;
  message.value = `DB 에서 불러왔습니다: 테이블 ${r.model.tables.length}개 (저장 전)`;
}

/** 「ERD 저장」 버튼: 누를 때마다 저장할 폴더를 고른다 (2026-10-16 사용자 지정).
 *  처음 위치는 DB 접속에 쓰는 BE 폴더의 docs/erd, 없으면 사용자 홈. 다른 모델이 든 폴더를 고르면 한 번 묻는다
 *  (저장할 때 그 폴더에서 이 모델에 없는 그룹 파일을 지우기 때문) */
async function save() {
  if (!model.value) return;
  // 사람이 확정해야 모델 파일에 저장된다 (설계 10-4)
  if (aiBase.value) { message.value = '확정 대기 중인 AI 변경을 확정하거나 취소한 뒤 저장하세요'; return; }
  const picked = await window.erd.model.pickSaveDir();
  if (!picked) return;
  return saveWithPreview(picked);
}

/** 고른 폴더에 저장 미리보기를 보이고, 「저장」 이면 저장한다 (시험 모드는 폴더 고르기 창 없이 이것을 부른다) */
async function saveWithPreview(picked: { dir: string; hasModel: boolean }) {
  if (!model.value) return;
  keepViewport(); // 확대, 화면 위치도 layout.json 에 함께 저장한다 (2026-10-16 사용자 요청)
  const other = [...docs.values()].find(x => x !== cur.value && sameDir(x.modelDir.value, picked.dir));
  if (other) { message.value = `${titleOf(other.id)} 탭에 열려 있는 폴더라 저장하지 않았습니다`; return; }
  const same = sameDir(picked.dir, modelDir.value);
  // 저장하면 바뀔 파일을 먼저 보여 주고 확인을 받는다 (2026-10-16 사용자 지정). 쓰기 전 소속 정리도 복사본으로 미리 해 본다
  const l = structuredClone(layout.value);
  pruneMembers(l, model.value);
  const plan = await window.erd.model.planSave(picked.dir, JSON.parse(JSON.stringify(model.value)), l);
  if (!await askSave({ dir: picked.dir, plan, otherModel: picked.hasModel && !same })) return;
  await setModelDir(picked.dir);
  return saveTo(picked.dir);
}

/** 저장 미리보기 창: 새로 씀, 바뀜, 지움, 그대로 파일 목록. 「저장」 이면 true */
const savePreview = ref<{ dir: string; plan: SavePlan; otherModel: boolean; resolve: (ok: boolean) => void } | null>(null);
const askSave = (p: { dir: string; plan: SavePlan; otherModel: boolean }) =>
  new Promise<boolean>(resolve => { savePreview.value = { ...p, resolve }; });
function answerSave(ok: boolean) { const p = savePreview.value; savePreview.value = null; p?.resolve(ok); }

/** 고른 폴더에 저장 (시험 모드는 폴더 고르기 없이 이것을 부른다) */
async function saveTo(dir: string) {
  if (!model.value) return;
  keepViewport();
  pruneMembers(layout.value, model.value); // 지운 테이블을 그룹 소속에서 정리한다 (화면에서는 되돌리기를 위해 남겨 둔다)
  const r = await window.erd.model.save(dir, model.value, layout.value);
  dirty.value = false;
  message.value = `저장했습니다 (${dir}): 바뀐 파일 ${r.written.length}개, 그대로 ${r.unchanged.length}개, 지운 파일 ${r.removed.length}개`;
  return r;
}

/** 끌어 옮긴 테이블들 (한 번 끌기에 여러 개면 되돌리기도 한 번) */
function onPin(pins: { id: string; x: number; y: number }[]) {
  const d = diagram.value;
  if (!d || !model.value) return;
  if (pins.every(p => String(d.pinned[p.id]) === String([p.x, p.y]))) return; // 제자리 (눌렀다 놓기만)
  history.pushSnap(snapNow());
  for (const p of pins) d.pinned[p.id] = [p.x, p.y];
  version.value++;
  dirty.value = true;
}

function autoArrange() {
  if (!diagram.value || !model.value) return;
  history.pushSnap(snapNow());
  diagram.value.pinned = {};
  version.value++;
  dirty.value = true;
}

/** 정렬 방식(트리, 그룹 격자)은 layout.json 에 다이어그램별로 저장된다. 바꾸면 끌어 옮긴 위치는 지운다 */
function setArrangeMode(mode: 'grid' | 'tree') {
  if (!diagram.value || !model.value || arrangeMode(diagram.value) === mode) return;
  history.pushSnap(snapNow());
  diagram.value.mode = mode;
  diagram.value.pinned = {};
  refreshDiagram(); // 그룹 격자 배치는 격자로 바꿀 때 만들고, 트리로 바꾸면 지운다
  version.value++;
  dirty.value = true;
}

// ---------- 그룹 탭 조작 (STEP 10) ----------
/** 지금 화면 위치를 보이는 다이어그램에 적어 둔다 (탭을 떠날 때, 저장할 때). 배율은 소수 셋째 자리, 위치는 정수 */
function keepViewport() {
  const v = canvas.value?.viewportNow();
  if (v && diagram.value) diagram.value.viewport = { x: Math.round(v.x), y: Math.round(v.y), zoom: Math.round(v.zoom * 1000) / 1000 };
}

function selectTab(name: string) {
  if (name !== DEFAULT_DIAGRAM && !membersOf(name)) return;
  keepViewport();
  tab.value = name;
  refreshDiagram();
  version.value++;
  fitKey.value++; // 탭을 바꾸면 그 탭에서 마지막으로 본 자리로 (없으면 전체 보기)
}

/** 탭 구성 바꾸기 (layout.json 만 바뀐다). 실패하면 화면 아래에 이유를 보인다 */
function tabOp(f: () => void, done: string): boolean {
  const before = snapNow(); // 그룹 탭 조작도 되돌린다
  try { f(); }
  catch (e) { if (!(e instanceof TabError)) throw e; message.value = `할 수 없습니다: ${e.message}`; return false; }
  history.pushSnap(before);
  refreshDiagram();
  version.value++;
  dirty.value = true;
  message.value = done;
  return true;
}
const idsOf = (names: string[]) => names.map(n => model.value!.tables.find(t => t.name === n)?.id).filter((x): x is string => !!x);

function addTab() {
  const name = newTabName(layout.value);
  if (tabOp(() => createTab(layout.value, name), `그룹 탭 ${name} 을(를) 만들었습니다 (저장 전). 테이블 우클릭이나 「테이블 추가」로 넣으세요`)) selectTab(name);
}
function onRenameTab(from: string, to: string) {
  if (tabOp(() => renameTab(layout.value, from, to), `탭 이름을 ${to}(으)로 바꿨습니다 (저장 전)`) && tab.value === from) tab.value = to;
}
async function onRemoveTab(name: string) {
  const n = membersOf(name)?.length ?? 0;
  if (await askDlg(`그룹 탭 「${name}」을(를) 지울까요?\n탭만 지우고 테이블 ${n}개는 모델에 그대로 남습니다.`, [{ label: '탭 지우기', value: 'ok' }, { label: '취소', value: '' }]) !== 'ok') return;
  if (tab.value === name) selectTab(DEFAULT_DIAGRAM);
  tabOp(() => deleteTab(layout.value, name), `그룹 탭 ${name} 을(를) 지웠습니다 (저장 전)`);
}
function onPrefixTabs() {
  let made: string[] = [];
  if (tabOp(() => { made = prefixTabs(layout.value, model.value!); }, '') ) {
    message.value = made.length ? `접두어 그룹 탭 ${made.length}개를 만들었습니다 (${made.join(', ')}, 저장 전)` : '새로 만들 접두어 그룹 탭이 없습니다';
    if (made.length) selectTab(made[0]);
  }
}
function addToGroup(names: string[], group: string) {
  let added: string[] = [];
  tabOp(() => { added = addMembers(layout.value, group, idsOf(names)); }, '');
  message.value = `「${group}」 탭에 ${added.length}개를 넣었습니다 (저장 전)`;
}
function newGroupWith(names: string[]) {
  const name = newTabName(layout.value);
  tabOp(() => createTab(layout.value, name, idsOf(names)), `「${name}」 탭을 만들어 ${names.length}개를 넣었습니다 (저장 전)`);
}
function removeFromGroup(names: string[]) {
  tabOp(() => removeMembers(layout.value, tab.value, idsOf(names)), `「${tab.value}」 탭에서 ${names.length}개를 뺐습니다. 모델에는 남아 있습니다 (저장 전)`);
}

/** 모델에서 테이블 지우기 (Delete 키, 우클릭 메뉴). 항상 확인 창에 함께 지워지는 FK 수를 보인다 (결정 13) */
async function deleteTables(names: string[]) {
  const m = model.value;
  if (!m || !names.length) return;
  const gone = new Set(names);
  const pointing = m.tables.filter(t => !gone.has(t.name)).reduce((n, t) => n + t.fks.filter(f => gone.has(f.refTable)).length, 0);
  const own = m.tables.filter(t => gone.has(t.name)).reduce((n, t) => n + t.fks.length, 0);
  const inGroup = membersOf(tab.value) ? `\n이 그룹에서만 빼려면 취소하고 우클릭 메뉴의 「이 그룹에서 빼기」를 쓰세요.` : '';
  const text = `${names.length === 1 ? names[0] : `테이블 ${names.length}개`}을(를) 모델에서 지울까요? (모든 탭에서 없어지며 되돌릴 수 있습니다)\n`
    + `이 테이블을 가리키는 다른 테이블의 FK ${pointing}개, 이 테이블의 FK ${own}개도 함께 지웁니다.${inGroup}`;
  if (await askDlg(text, [{ label: '모델에서 삭제', value: 'ok' }, { label: '취소', value: '' }]) !== 'ok') return;
  if (edit(x => names.reduce((acc, n) => dropTable(acc, n), x))) message.value = `모델에서 지웠습니다: ${names.join(', ')} (저장 전)`;
}

// 확인 창 (window.confirm 대신: 시험 모드에서 막히지 않고 버튼을 여러 개 둘 수 있다)
const dlg = ref<{ text: string; buttons: { label: string; value: string }[]; resolve: (v: string) => void } | null>(null);
const askDlg = (text: string, buttons: { label: string; value: string }[]) =>
  new Promise<string>(resolve => { dlg.value?.resolve(''); dlg.value = { text, buttons, resolve }; });
function answerDlg(v: string) { const d = dlg.value; dlg.value = null; d?.resolve(v); }

// 우클릭 메뉴: 테이블 위면 그 테이블(고른 것 중이면 고른 것 모두), 빈 곳이면 테이블 추가
const menu = ref<{ x: number; y: number; names: string[] } | null>(null);
function onMenu(e: { x: number; y: number; name?: string }) {
  const names = e.name ? (selected.value.includes(e.name) ? [...selected.value] : [e.name]) : [];
  menu.value = { x: e.x, y: e.y, names };
}
/** 메뉴의 「그룹에 추가」 대상: 고른 테이블이 모두 들어 있지는 않은 그룹 탭 */
const menuGroups = computed(() => {
  const mm = menu.value;
  if (!mm?.names.length || !model.value) return [];
  const ids = idsOf(mm.names);
  return tabNames.value.filter(n => n !== tab.value && !ids.every(id => membersOf(n)!.includes(id)));
});
/** 메뉴를 닫고 실행한다. 고른 테이블 이름은 닫기 전에 받아 둔다 */
function runMenu(f: (names: string[]) => void) { const names = menu.value?.names ?? []; menu.value = null; f(names); }
window.addEventListener('mousedown', e => { if (menu.value && !(e.target as HTMLElement).closest('.ctx')) menu.value = null; }, true);

// ---------- 선 끌어 FK 만들기 (STEP 10) ----------
// 놓으면 확인 창에서 FK 이름, 자식 컬럼(기존 또는 새 컬럼), ON DELETE 를 고른다. 새 컬럼과 FK 는 되돌리기 한 번이다.
// 그룹 탭에는 소속 테이블만 그려지므로 같은 그룹끼리만 이어진다 (결정 의 선 연결 마지막 줄)
const canConnect = (a: End, b: End) => !!model.value && planConnect(model.value, a, b).ok;
const connectAsk = ref<{ plan: Extract<ConnectPlan, { ok: true }>; fkName: string; childColumn: string; onDelete: FkAction | '' } | null>(null);
const NEW_COL = ' new'; // 「새 컬럼」 고르기 값. 컬럼 이름에는 공백이 들어갈 수 없어 겹치지 않는다
function onConnectTables(a: End, b: End) {
  if (!model.value) return;
  const plan = planConnect(model.value, a, b);
  if (!plan.ok) {
    message.value = `선으로 연결할 수 없습니다: ${plan.error}`;
    // 복합 PK 부모는 자식 쪽 편집 패널로 안내한다 (결정 9)
    if (plan.composite) {
      const ta = model.value.tables.find(t => t.name === a.table);
      const aIsParent = !!ta && ta.pk.length > 1 && (!a.column || ta.pk.includes(a.column));
      openEditor(aIsParent ? b.table : a.table);
    }
    return;
  }
  connectAsk.value = { plan, fkName: plan.fkName, childColumn: plan.childColumn ?? NEW_COL, onDelete: '' };
}
function answerConnect(ok: boolean) {
  const c = connectAsk.value;
  connectAsk.value = null;
  if (!ok || !c) return;
  const choice = { fkName: c.fkName.trim(), childColumn: c.childColumn === NEW_COL ? null : c.childColumn, ...(c.onDelete ? { onDelete: c.onDelete } : {}) };
  if (edit(m => applyConnect(m, c.plan, choice))) message.value = `FK ${choice.fkName} 을(를) 만들었습니다: ${c.plan.child} → ${c.plan.parent} (저장 전)`;
}
/** 고른 FK 선 (Delete 로 지운다) */
const selectedFks = ref<{ table: string; fk: string }[]>([]);
function deleteFks(fks: { table: string; fk: string }[]) {
  if (edit(m => fks.reduce((acc, f) => dropFk(acc, f.table, f.fk), m))) message.value = `FK 를 지웠습니다: ${fks.map(f => f.fk).join(', ')} (저장 전)`;
}

// ---------- 컬럼 고르기, 복사, 붙여넣기 (2026-10-16 사용자 요청) ----------
// 컬럼 행을 누르면 고르고(Shift, Ctrl 로 더하기), Ctrl+C 로 복사, 붙일 테이블을 고르고 Ctrl+V 로 그 테이블 맨 아래에 붙인다.
// 복사한 컬럼은 다른 ERD 탭(다른 모델)에도 붙일 수 있다. 같은 이름이 있으면 건너뛴다
view.onColumnClick = (table, column, add) => {
  const k = colKey(table, column);
  view.colSel = add ? (view.colSel.includes(k) ? view.colSel.filter(x => x !== k) : [...view.colSel, k]) : [k];
};
let colClipboard: { from: string; columns: Column[] } | null = null;
function copyColumns(): boolean {
  const m = model.value;
  if (!m || !view.colSel.length) return false;
  const cols = view.colSel.map(k => { const [t, c] = k.split('\t'); return m.tables.find(x => x.name === t)?.columns.find(x => x.name === c); })
    .filter((c): c is Column => !!c).map(c => ({ ...c }));
  if (!cols.length) return false;
  const from = [...new Set(view.colSel.map(k => k.split('\t')[0]))].join(', ');
  colClipboard = { from, columns: cols };
  // 글로도 복사해 둔다 (메모장, 메신저에 붙일 때). 한 줄에 컬럼 하나, 모델 파일 표기
  void navigator.clipboard?.writeText(cols.map(c => columnText(c, false)).join(NL)).catch(() => undefined);
  message.value = `컬럼 ${cols.length}개를 복사했습니다 (${from}). 붙일 테이블을 고르고 Ctrl+V 를 누르세요`;
  return true;
}
function pasteColumnsHere(): boolean {
  if (!colClipboard || !model.value) return false;
  const target = model.value.tables.find(t => t.id === pickId.value)?.name;
  if (!target) { message.value = '붙일 테이블을 먼저 고르세요'; return true; }
  let r: ReturnType<typeof pasteColumns> | null = null;
  const clip = colClipboard;
  if (!edit(m => { r = pasteColumns(m, target, clip.columns); return r.model; })) return true;
  const res = r as ReturnType<typeof pasteColumns> | null;
  if (!res) return true;
  view.colSel = res.added.map(c => colKey(target, c));
  message.value = res.added.length
    ? `${target} 에 컬럼 ${res.added.length}개를 붙였습니다${res.skipped.length ? ` (같은 이름이 있어 건너뜀: ${res.skipped.join(', ')})` : ''}`
    : `붙일 컬럼이 없습니다. ${target} 에 같은 이름이 모두 있습니다 (${res.skipped.join(', ')})`;
  return true;
}

// ---------- 도메인 관리 패널 (STEP 10) ----------
// 오른쪽 영역은 테이블 편집 패널 > 도메인 패널 > 미니 ERD 순서로 보인다
const domainOpen = ref(false);
const domainPanel = ref<InstanceType<typeof DomainPanel>>();
function openDomains() { editId.value = ''; miniName.value = ''; domainOpen.value = true; }
/** 도메인 삭제: 쓰는 컬럼 수를 보이고 먼저 묻는다. 지우면 연결만 풀고 타입은 남는다 (결정 4) */
async function removeDomain(name: string) {
  const n = model.value ? domainUsage(model.value, name).length : 0;
  if (await askDlg(`도메인 ${name} 을(를) 지울까요?` + NL + `이 도메인을 쓰는 컬럼 ${n}개는 연결만 풀리고 지금 타입은 그대로 남습니다.`,
    [{ label: '지우기', value: 'ok' }, { label: '취소', value: '' }]) !== 'ok') return;
  edit(m => dropDomain(m, name), undefined, `도메인 ${name} 을(를) 지웠습니다. 컬럼 ${n}개는 연결만 풀렸습니다 (저장 전)`);
}

// 그룹 탭에 기존 테이블 가져오기
const pickOpen = ref(false);
const pickTables = computed(() => {
  void version.value;
  const mem = new Set(membersOf(tab.value) ?? []);
  return (model.value?.tables ?? []).filter(t => !mem.has(t.id)).map(t => ({ name: t.name, comment: t.comment }));
});
const picker = ref<InstanceType<typeof TablePickDialog>>();
function onPick(names: string[]) {
  pickOpen.value = false;
  addToGroup(names, tab.value);
}

// 미니 ERD: 더블클릭한 테이블과 FK 로 바로 이어진 테이블만, 항상 트리로
const miniName = docField(cur, 'miniName');
const miniModel = computed(() => (model.value && miniName.value ? neighborhood(model.value, miniName.value) : null));
const miniDiagram: Diagram = { mode: 'tree', pinned: {} };
const mini = ref<InstanceType<typeof ErdCanvas>>();
const compare = ref<InstanceType<typeof CompareTab>>();
const editor = ref<InstanceType<typeof TableEditor>>();

// ---------- 위 영역 탭: ERD, SQL / 아래 영역: 터미널 ----------
interface Tab { id: string; kind: 'erd' | 'sql' | 'compare' | 'export'; title: string; dirty: boolean; initialSql?: string; initialConn?: string }
const tabs = ref<Tab[]>([{ id: 'erd', kind: 'erd', title: 'ERD', dirty: false }]);
const activeTab = ref('erd');
const isErd = (id: string) => docs.has(id);
/** ERD 탭 제목: 모델 폴더(BE 레포 이름), 없으면 ERD n */
const titleOf = (id: string) => docTitle(docs.get(id)!, tabs.value.find(t => t.id === id)?.title ?? 'ERD');
let erdSeq = 1;

// ERD 탭을 고르면 그 탭의 상태로 바꾼다. 떠나는 탭의 화면 위치를 남겨 돌아오면 그 자리로 연다 (캔버스는 탭마다 새로 만든다)
watch(activeTab, id => {
  const d = docs.get(id);
  if (!d || d === cur.value) return;
  if (canvas.value) { keepViewport(); cur.value.viewport = canvas.value.viewportNow(); }
  cur.value = d;
  selected.value = [];
});

/** 새 ERD 탭 (빈 상태. ERD 폴더 열기나 DB 에서 불러오기로 채운다) */
function addErd(): string {
  const id = `erd-${++erdSeq}`;
  docs.set(id, newDoc(id));
  const at = tabs.value.map(t => t.kind).lastIndexOf('erd') + 1;
  tabs.value.splice(at, 0, { id, kind: 'erd', title: `ERD ${erdSeq}`, dirty: false });
  activeTab.value = id;
  return id;
}
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
  const el = e.target as HTMLElement;
  if (e.key === 'Escape' && menu.value) { menu.value = null; return; }
  if (e.key === 'Escape' && dlg.value) { answerDlg(''); return; }
  if (e.key === 'Escape' && view.colSel.length && isErd(activeTab.value)) { view.colSel = []; return; }
  if (!isErd(activeTab.value) || pwAsk.value || closeAsk.value || dlg.value || pickOpen.value || connectAsk.value || savePreview.value) return;
  // Delete: 고른 테이블을 모델에서 지운다 (확인 창). 입력 칸 안의 Delete 는 그대로 둔다 (STEP 10)
  if (e.key === 'Delete' && !el.closest('input, textarea, select, [contenteditable]')) {
    if (selected.value.length) { e.preventDefault(); void deleteTables([...selected.value]); }
    else if (selectedFks.value.length) { e.preventDefault(); deleteFks([...selectedFks.value]); }
    return;
  }
  // Enter: 고른 테이블(없으면 편집 중인 테이블)에 컬럼을 더한다 (STEP 10). 입력 칸, 버튼 위의 Enter 는 그대로 둔다
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing && !el.closest('input, textarea, select, button, [contenteditable]')) {
    const name = model.value?.tables.find(t => t.id === pickId.value)?.name;
    if (name) { e.preventDefault(); void enterColumn(name); }
    return;
  }
  // 되돌리기, 다시 하기는 ERD 탭에서만. 입력 칸 안에서는 그 칸의 글자 되돌리기를 그대로 둔다.
  // 단 Enter 로 막 더한 컬럼 이름 칸처럼 글자를 고치지 않은 칸(data-orig 와 같은 칸)은 모델 되돌리기로 넘긴다
  // Ctrl+C, Ctrl+V: 고른 컬럼 복사, 고른 테이블에 붙이기. 입력 칸 안에서는 글자 복사 그대로
  if (e.ctrlKey && !e.shiftKey && !el.closest('input, textarea, select, [contenteditable]')) {
    const k = e.key.toLowerCase();
    if (k === 'c' && copyColumns()) { e.preventDefault(); return; }
    if (k === 'v' && pasteColumnsHere()) { e.preventDefault(); return; }
  }
  const untouched = el instanceof HTMLInputElement && el.dataset.orig !== undefined && el.value === el.dataset.orig;
  if (!e.ctrlKey || (!untouched && el.closest('input, textarea, select, [contenteditable]'))) return;
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
  if (t.kind === 'erd') {
    const d = docs.get(t.id)!;
    if (tabs.value.filter(x => x.kind === 'erd').length < 2) return; // ERD 탭은 하나는 남긴다
    if ((d.dirty.value || d.aiBase.value) && await askDlg(`${titleOf(t.id)} 탭에 저장하지 않은 ERD 변경이 있습니다${d.aiBase.value ? ' (확정 대기 중인 AI 변경 포함)' : ''}.` + NL + '탭을 닫으면 이 변경은 사라집니다.',
      [{ label: '닫기', value: 'ok' }, { label: '취소', value: '' }]) !== 'ok') return;
    if (cur.value === d) { // 닫는 탭이 지금 ERD 탭이면 다른 ERD 탭을 먼저 지금 탭으로
      const next = tabs.value.filter(x => x.kind === 'erd' && x.id !== t.id).at(-1)!;
      cur.value = docs.get(next.id)!;
      if (activeTab.value === t.id) activeTab.value = next.id;
    }
    docs.delete(t.id);
  }
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
  await saveSession(); // 저장 안 한 ERD 변경은 마지막 화면에 담아 다시 켜면 돌아온다 (묻지 않는다)
  if (!dirty.length) { window.erd.confirmClose(true); return; }
  const a = await ask(dirty.map(d => tabs.value.find(t => t.id === d.tabId)?.title ?? d.label));
  if (a !== 'cancel') for (const d of dirty) await window.erd.sql[a](d.tabId);
  window.erd.confirmClose(a !== 'cancel');
});

// ---------- 마지막 화면 (STEP 10 결정 22) ----------
// ERD 탭(저장 안 한 변경, 보던 그룹 탭, 화면 위치), SQL 탭 글자와 접속, 위 탭 순서와 보던 탭을 session.json 에 담는다.
// 2초마다 바뀐 것이 있으면 쓰고, 창을 닫을 때 한 번 더 쓴다. 비교, 내보내기 탭과 터미널은 담지 않는다.
let restoring = true; // 되살리는 중에는 쓰지 않는다 (반쯤 연 화면으로 덮어쓰지 않게)
let lastSession = '';
const modelJson = new WeakMap<object, string>(); // 같은 모델은 다시 글자로 바꾸지 않는다

function sessionNow(): SessionData {
  const out: SessionTab[] = [];
  for (const t of tabs.value) {
    const d = docs.get(t.id);
    if (d) {
      const viewport = d === cur.value && canvas.value ? canvas.value.viewportNow() : d.viewport;
      const m = d.model.value;
      // 확정 대기 중인 AI 변경도 저장 안 한 변경으로 담는다 (다시 켜면 강조 없이 바뀐 모델로 열린다)
      const unsaved = m && (d.dirty.value || d.aiBase.value) ? { model: m, layout: d.layout.value } : undefined;
      out.push({ kind: 'erd', id: t.id, modelDir: d.modelDir.value, diagram: d.tab.value, ...(viewport ? { viewport } : {}), ...(unsaved ? { unsaved } : {}) });
    } else if (t.kind === 'sql') {
      const tab = tabRefs.get(t.id) as InstanceType<typeof SqlTab> | undefined;
      const conn = tab?.connKey() || t.initialConn;
      out.push({ kind: 'sql', id: t.id, title: t.title, sql: tab?.text() ?? t.initialSql ?? '', ...(conn ? { conn } : {}) });
    }
  }
  const active = tabs.value.some(t => t.id === activeTab.value && (isErd(t.id) || t.kind === 'sql')) ? activeTab.value : cur.value.id;
  return { version: 1, active, tabs: out };
}

/** 바뀐 것이 있을 때만 쓴다 */
async function saveSession() {
  if (restoring) return;
  const data = sessionNow();
  const key = JSON.stringify(data, (k, v) => {
    if (k === 'model' && v && typeof v === 'object') {
      let j = modelJson.get(v);
      if (!j) { j = JSON.stringify(v); modelJson.set(v, j); }
      return j; // 모델은 고칠 때마다 새 객체라 객체마다 한 번만 글자로 바꾼다
    }
    return v;
  });
  if (key === lastSession) return;
  lastSession = key;
  try { await window.erd.session.set(JSON.parse(JSON.stringify(data))); }
  catch (e) { message.value = `마지막 화면을 저장하지 못했습니다: ${cleanError(e)}`; }
}
setInterval(() => void saveSession(), 2000);

/** 시작할 때: 마지막 화면이 있으면 그대로 연다. 없으면 설정의 모델 폴더만 고른 상태로 시작한다 (예전과 같다) */
async function restoreSession() {
  try {
    const s = await window.erd.session.get();
    if (!s?.tabs.length) {
      const st = await window.erd.settings.get();
      if (st.modelDir) modelDir.value = st.modelDir;
      return;
    }
    const kept: Tab[] = [];
    const notes: string[] = [];
    for (const t of s.tabs) {
      if (t.kind === 'erd') {
        const d = t.id === 'erd' ? docs.get('erd')! : newDoc(t.id);
        docs.set(t.id, d);
        const n = Number(/^erd-(\d+)$/.exec(t.id)?.[1] ?? 1);
        erdSeq = Math.max(erdSeq, n);
        kept.push({ id: t.id, kind: 'erd', title: n > 1 ? `ERD ${n}` : 'ERD', dirty: false });
        d.modelDir.value = t.modelDir;
        if (t.viewport) d.viewport = t.viewport;
        cur.value = d;
        if (t.unsaved) {
          show(t.unsaved.model, t.unsaved.layout);
          dirty.value = true;
        } else if (t.modelDir) {
          try {
            const r = await window.erd.model.load(t.modelDir);
            errors.value = r.errors;
            show(r.model, r.layout);
          } catch (e) { notes.push(`${docTitle(d, 'ERD')}: ${cleanError(e)}`); }
        }
        if (d.model.value && membersOf(t.diagram)) { tab.value = t.diagram; refreshDiagram(); }
      } else {
        const n = Number(/^sql-(\d+)$/.exec(t.id)?.[1] ?? 0);
        seq = Math.max(seq, n);
        kept.push({ id: t.id, kind: 'sql', title: t.title, dirty: false, initialSql: t.sql, initialConn: t.conn });
      }
    }
    if (!kept.some(t => t.kind === 'erd')) kept.unshift(tabs.value[0]);
    for (const id of [...docs.keys()]) if (!kept.some(t => t.id === id)) docs.delete(id); // 닫았던 첫 ERD 탭
    tabs.value = kept;
    const first = kept.find(t => t.kind === 'erd')!;
    cur.value = docs.get(kept.some(t => t.id === s.active && isErd(t.id)) ? s.active : first.id)!;
    activeTab.value = kept.some(t => t.id === s.active) ? s.active : first.id;
    message.value = notes.length ? `마지막 화면을 열었습니다. 열지 못한 것: ${notes.join(', ')}` : '마지막 화면을 열었습니다';
  } finally {
    restoring = false;
  }
}
const restored = restoreSession();

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

/** 자동완성 목록 시험: dev 에 접속한 SQL 탭에서 글자를 쳐 목록을 띄우고, 항목 글자와 글자색, 배경색을 잰다 (화면은 메인이 캡처) */
async function suggestScenario(beDir: string) {
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  const id = addSql();
  await nextTick(); await frames(5);
  const tab = tabRefs.get(id) as InstanceType<typeof SqlTab>;
  await tab.loadOptions();
  await tab.connect('be:dev');
  await sleep(2000); // 접속한 DB 목록 읽기
  const ed = tab.editor()!;
  ed.setValue('');
  ed.focus();
  for (const ch of 'select * from mst_b') ed.trigger('keyboard', 'type', { text: ch });
  await sleep(1200);
  const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')).slice(0, 5);
  const style = (el: Element | null) => { if (!el) return null; const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor, font: s.fontFamily.slice(0, 60), size: s.fontSize, opacity: s.opacity }; };
  const widget = document.querySelector('.suggest-widget');
  return {
    catalogTables: tab.catalogSize(),
    rows: rows.map(r => ({ aria: r.getAttribute('aria-label'), text: r.textContent?.trim().slice(0, 80), label: style(r.querySelector('.label-name') ?? r) })),
    widget: style(widget), row0: style(rows[0] ?? null),
    labelNameStyle: style(document.querySelector('.suggest-widget .monaco-list-row .label-name')),
    highlight: style(document.querySelector('.suggest-widget .monaco-list-row .monaco-highlighted-label')),
  };
}

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

/** STEP 9: 다른 DBMS 를 직접 입력 접속으로 붙여 접속 시험 → 리버스 → 저장 → 캔버스 → SQL 탭 조회. 접속은 끝에 지운다 */
async function dbmsScenario(baseDir: string, list: { name: string; conn: ManualConn; password: string; sql: string }[]) {
  const out: Record<string, unknown> = {};
  for (const d of list) {
    const saved = await window.erd.manual.save({ ...d.conn, id: '', name: d.name, savePassword: false }, d.password);
    const ref: ConnRef = { source: 'manual', id: saved.id };
    try {
      const test = await window.erd.conn.test(ref);
      const dir = `${baseDir}/${d.conn.driver}`;
      await setModelDir(dir);
      const r = await window.erd.db.reverse(ref, dir);
      applyReverse(r);
      await saveTo(dir);
      await openModel(dir);
      await nextTick(); await frames(10); await sleep(800);
      const id = addSql();
      await nextTick(); await frames(5);
      const tab = tabRefs.get(id) as InstanceType<typeof SqlTab>;
      await tab.loadOptions();
      await tab.connect('manual:' + saved.id);
      tab.editor()!.setValue(d.sql);
      await tab.run();
      await frames(5); await sleep(300);
      out[d.conn.driver] = {
        test: { ok: test.ok, tables: test.tables, fks: test.fks, server: test.server },
        reverse: { tables: r.model.tables.length, fks: r.model.tables.reduce((n, t) => n + t.fks.length, 0), counts: r.counts, dialect: r.model.dialect, schema: r.model.schema, warnings: r.warnings.length },
        loaded: { tables: model.value?.tables.length, dialect: model.value?.dialect, nodes: document.querySelectorAll('.vue-flow__node').length },
        sql: { grid: tab.grid(), state: tab.state() },
      };
    } catch (e) {
      out[d.conn.driver] = { error: (e as Error).message };
    } finally {
      await window.erd.manual.remove(saved.id);
    }
  }
  return JSON.parse(JSON.stringify(out));
}

/** STEP 10 시험: 모델만 연다. 키보드, 마우스 입력은 메인이 실제 입력으로 보내고 __erdProbe 로 화면 상태를 읽는다 */
async function step10Scenario(beDir: string, dir: string, part?: string) {
  await restored;
  await panel.value!.setSource('be');
  await panel.value!.setBeDir(beDir);
  if (part === 'session2') { await nextTick(); await frames(10); await sleep(1500); return sessionState(); } // 마지막 화면으로 열린 것을 본다
  await openModel(dir);
  activeTab.value = 'erd';
  await nextTick(); await frames(10); await sleep(800);
  return { tables: model.value?.tables.length };
}
window.__erdProbe = (table?: string) => {
  const t = table ? model.value?.tables.find(x => x.name === table) : undefined;
  const a = document.activeElement as HTMLInputElement | null;
  return JSON.parse(JSON.stringify({
    selected: selected.value, editor: editName.value, canUndo: canUndo.value, canRedo: canRedo.value, message: message.value,
    columns: t?.columns.map(c => `${c.name} ${c.type}${c.notNull ? ' NN' : ''}`), focused: a?.tagName === 'INPUT' ? a.value : a?.tagName,
    ...groupState(),
  }));
};
/** 그룹 탭 상태: 보이는 탭, 탭별 소속 이름과 고정 위치, 캔버스에 그려진 테이블과 선 수, 외부 FK 배지, 열린 창 */
function groupState() {
  const name = (id: string) => model.value?.tables.find(t => t.id === id)?.name ?? `(없음 ${id})`;
  const tabs: Record<string, { members: string[]; pinned: Record<string, [number, number]> }> = {};
  for (const n of tabNames.value) {
    const d = layout.value.diagrams[n];
    tabs[n] = { members: d.members!.map(name), pinned: Object.fromEntries(Object.entries(d.pinned).map(([id, p]) => [name(id), p])) };
  }
  const main = '.pane.canvas .split > .pane:first-child';
  return {
    tab: tab.value, tabs, modelTables: model.value?.tables.length,
    nodes: Array.from(document.querySelectorAll(`${main} .vue-flow__node-table .head b`)).map(e => e.textContent).sort(),
    edges: document.querySelectorAll(`${main} .vue-flow__edge`).length,
    extBadges: Array.from(document.querySelectorAll(`${main} .vue-flow__node-table .ext`)).map(e => `${e.closest('.head')?.querySelector('b')?.textContent}: ${e.textContent}`),
    dialog: dlg.value?.text ?? null, pick: pickOpen.value, menu: menu.value ? Array.from(document.querySelectorAll('.ctx button')).map(e => e.textContent?.trim()) : null,
    mini: miniName.value, miniTables: Array.from(document.querySelectorAll('.mini .vue-flow__node-table .head b')).map(e => e.textContent).sort(),
    dirty: dirty.value,
  };
}
/** 시험용: 지금 모델을 dir 에 저장하고 다시 열어 그룹 탭 상태를 저장 전과 비교한다 */
window.__erdSaveReopen = async (dir: string) => {
  const before = groupState();
  const saved = await saveTo(dir);
  const keep = tab.value;
  await openModel(dir);
  selectTab(keep);
  await nextTick(); await frames(10); await sleep(600);
  const after = groupState();
  return JSON.parse(JSON.stringify({ written: saved?.written, before: before.tabs, after: after.tabs, same: JSON.stringify(before.tabs) === JSON.stringify(after.tabs), tab: after.tab, nodes: after.nodes }));
};

/** 마지막 화면 시험용: 위 탭, ERD 탭마다 모델 폴더, 저장 안 함 여부, 컬럼 수, 그룹 탭, 화면 위치, SQL 탭 글자와 접속 */
function sessionState() {
  const erd = (id: string) => {
    const d = docs.get(id)!;
    const t = d.model.value?.tables.find(x => x.name === 'mst_biz_wh');
    return { dir: d.modelDir.value.split(/[\\/]/).pop(), title: titleOf(id), dirty: d.dirty.value, tables: d.model.value?.tables.length, whColumns: t?.columns.map(c => c.name),
      diagram: d.tab.value, groupTabs: groupTabs(d.layout.value), viewport: d === cur.value && canvas.value ? canvas.value.viewportNow() : d.viewport };
  };
  return JSON.parse(JSON.stringify({
    active: activeTab.value, cur: cur.value.id,
    tabs: tabs.value.map(t => (isErd(t.id) ? { id: t.id, ...erd(t.id) } : t.kind === 'sql'
      ? { id: t.id, title: t.title, text: (tabRefs.get(t.id) as InstanceType<typeof SqlTab> | undefined)?.text(), conn: (tabRefs.get(t.id) as InstanceType<typeof SqlTab> | undefined)?.connKey() } : { id: t.id })),
    nodes: document.querySelectorAll('.pane.canvas .split > .pane:first-child .vue-flow__node-table').length, message: message.value,
  }));
}
window.__erdSession = async (step: string, arg?: string) => {
  if (step === 'open') { await openModel(arg); await nextTick(); await frames(10); await sleep(600); }
  if (step === 'addErd') { addErd(); await nextTick(); }
  if (step === 'addSql') {
    const id = addSql(arg ?? '');
    await nextTick(); await frames(5);
    const tab = tabRefs.get(id) as InstanceType<typeof SqlTab>;
    await tab.loadOptions();
    await tab.connect('be:dev');
  }
  if (step === 'activate') { activeTab.value = arg!; await nextTick(); await frames(10); await sleep(800); }
  if (step === 'pan') { await canvas.value!.fitView({ nodes: [model.value!.tables.find(t => t.name === arg)!.id], maxZoom: 0.8 }); await sleep(600); }
  if (step === 'flush') { lastSession = ''; await saveSession(); }
  return sessionState();
};

/**
 * 선 연결 시험 (STEP 10 완료 기준): dev 를 불러온 ERD 에 시험 테이블 mst_erd_probe 를 만들고, 메인이 실제 마우스로 선을 끌어 FK 를 만든다.
 * 그 ERD 를 dev 에 적용(커밋)하고 다시 읽어 차이 0 을 본 뒤, 되돌리기로 처음 모델로 돌아가 같은 길로 dev 에서 시험 테이블을 지운다.
 */
const PROBE = 'mst_erd_probe';
const mainSel = '.pane.canvas .split > .pane:first-child';
const devRef = (beDir: string) => ({ source: 'be' as const, beDir, name: 'dev' });
let connectBase: SchemaModel | null = null;
window.__erdConnect = async (step: string, a?: string, b?: string) => {
  const center = (el: Element | null | undefined) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const nodeEl = (name: string) => document.querySelector(`${mainSel} .vue-flow__node-table[data-id="${model.value!.tables.find(t => t.name === name)?.id}"]`);
  const diffDev = async () => diffModels((await window.erd.db.read(devRef(a!))).model, model.value!).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}`);
  /** 지금 ERD 를 dev 에 적용: 「DB 에 적용」 → 비교 탭 「왼쪽 DB 에 적용」 → 새 SQL 탭 「전체 실행」 → 커밋 (step6 과 같은 길) */
  const applyAndCommit = async () => {
    activeTab.value = 'erd';
    await applyToDb();
    const items = compare.value!.items().map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}`);
    const before = tabs.value.length;
    compare.value!.apply();
    await nextTick(); await frames(5); await sleep(2500);
    const t = tabs.value[before];
    const tab = tabRefs.get(t.id) as InstanceType<typeof SqlTab>;
    const run = await tab.runAll();
    await tab.tx('commit');
    activeTab.value = 'erd';
    await nextTick(); await frames(10); await sleep(600);
    return { items, run };
  };
  if (step === 'prep') { // a: BE 폴더. dev 를 불러와 ERD 를 dev 와 같게 한 뒤 시험 테이블을 만든다
    await panel.value!.setSource('be'); await panel.value!.setBeDir(a!);
    panel.value!.select('dev');
    await panel.value!.doReverse();
    panel.value!.apply();
    connectBase = model.value;
    edit(m => addTable(m, PROBE, { comment: 'ERD 도구 선 연결 시험' }));
    edit(m => addColumn(m, PROBE, { name: 'probe_seq', type: 'integer', notNull: true, pk: true }));
    edit(m => addColumn(m, PROBE, { name: 'wh_seq', type: 'integer', notNull: false }));
    edit(m => addTable(m, PROBE + '_nopk', { comment: 'PK 없는 시험 테이블' }));
    edit(m => addColumn(m, PROBE + '_nopk', { name: 'memo_txt', type: 'text', notNull: false }));
    edit(m => addTable(m, PROBE + '_cpk', { comment: '복합 PK 시험 테이블' }));
    edit(m => addColumn(m, PROBE + '_cpk', { name: 'a_seq', type: 'integer', notNull: true, pk: true }));
    edit(m => addColumn(m, PROBE + '_cpk', { name: 'b_seq', type: 'integer', notNull: true, pk: true }));
    // 시험 테이블을 mst_biz 오른쪽, mst_wh 를 그 아래에 고정해 셋이 한 화면에 보이게
    await nextTick(); await frames(10);
    const boxes = canvas.value!.boxes();
    const id = (n: string) => model.value!.tables.find(t => t.name === n)!.id;
    const biz = boxes.get(id('mst_biz'))!;
    diagram.value!.pinned[id(PROBE)] = [biz.x + biz.w + 160, biz.y];
    diagram.value!.pinned[id('mst_wh')] = [biz.x + biz.w + 160, biz.y + 200];
    diagram.value!.pinned[id(PROBE + '_nopk')] = [biz.x + biz.w + 560, biz.y];
    diagram.value!.pinned[id(PROBE + '_cpk')] = [biz.x + biz.w + 560, biz.y + 200];
    version.value++;
    await nextTick(); await frames(10);
    await canvas.value!.fitView({ nodes: [id('mst_biz'), id(PROBE), id('mst_wh'), id(PROBE + '_cpk'), id(PROBE + '_nopk')], padding: 0.1 });
    await sleep(400); // 화면 맞추기가 끝난 뒤 위치를 읽게
    await sleep(800);
    return { before: await diffDev() };
  }
  if (step === 'handle') { // a 테이블, b 연결점 ID
    const h = nodeEl(a!)?.querySelector(`.vue-flow__handle[data-handleid="${b}"]`);
    const p = center(h);
    return p;
  }
  if (step === 'body') { const r = nodeEl(a!)?.getBoundingClientRect(); return r ? { x: r.x + r.width * 0.45, y: r.y + r.height - 8 } : null; } // 연결점이 아닌 몸통
  if (step === 'edge') { // a 테이블의 FK b 선 가운데
    const t = model.value!.tables.find(x => x.name === a)!;
    const path = document.querySelector<SVGPathElement>(`${mainSel} .vue-flow__edge[data-id="${t.id}:${b}"] path.vue-flow__edge-path`);
    if (!path) return null;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
  }
  if (step === 'answer') { // 확인 창 값 고르기 (메인이 「만들기」 를 누른다)
    if (a === 'onDelete' && connectAsk.value) connectAsk.value.onDelete = b as FkAction;
    return null;
  }
  if (step === 'apply') { const r = await applyAndCommit(); return { ...r, after: await diffDev() }; }
  if (step === 'cleanup') {
    let undos = 0;
    while (canUndo.value) { undo(); undos++; }
    const r = await applyAndCommit();
    return { undos, sameAsBase: model.value === connectBase, ...r, after: await diffDev() };
  }
  const t = model.value?.tables.find(x => x.name === PROBE);
  return JSON.parse(JSON.stringify({
    columns: t?.columns.map(c => `${c.name} ${c.type}${c.notNull ? ' NN' : ''}`), fks: t?.fks, message: message.value, editor: editName.value,
    ask: connectAsk.value && { child: connectAsk.value.plan.child, parent: connectAsk.value.plan.parent, childColumn: connectAsk.value.childColumn, fkName: connectAsk.value.fkName },
    edges: document.querySelectorAll(`${mainSel} .vue-flow__edge`).length, selectedFks: selectedFks.value, canUndo: canUndo.value,
  }));
};

/**
 * 도메인 시험 (STEP 10 완료 기준). dir 은 시험용 빈 모델 폴더. dev 를 그 폴더로 불러오고 시험 테이블을 dev 에 만든 뒤,
 * 메인이 실제 입력으로 도메인을 만들고 연결하고 타입을 고친다. 여기서는 dev 적용, 저장, DB 직접 변경, 다시 불러오기, 정리를 한다.
 */
window.__erdDomain = async (step: string, a?: string, b?: string) => {
  const probe = 'mst_erd_probe';
  const t = () => model.value?.tables.find(x => x.name === probe);
  const diffDev = async () => diffModels((await window.erd.db.read(devRef(a!))).model, model.value!).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}`);
  const applyAndCommit = async () => {
    activeTab.value = 'erd';
    await applyToDb();
    const items = compare.value!.items().map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}`);
    if (!items.length) return { items };
    const before = tabs.value.length;
    compare.value!.apply();
    await nextTick(); await frames(5); await sleep(2500);
    const tb = tabs.value[before];
    const tab = tabRefs.get(tb.id) as InstanceType<typeof SqlTab>;
    const run = await tab.runAll();
    await tab.tx('commit');
    activeTab.value = 'erd';
    await nextTick(); await frames(10); await sleep(600);
    return { items, run };
  };
  if (step === 'prep') { // a: BE 폴더, b: 시험용 빈 모델 폴더
    await panel.value!.setSource('be'); await panel.value!.setBeDir(a!);
    await setModelDir(b!);
    panel.value!.select('dev');
    await panel.value!.doReverse();
    panel.value!.apply();
    edit(m => addTable(m, probe, { comment: 'ERD 도구 도메인 시험' }));
    edit(m => addColumn(m, probe, { name: 'probe_seq', type: 'integer', notNull: true, pk: true }));
    edit(m => addColumn(m, probe, { name: 'a_cd', type: 'varchar(10)', notNull: false }));
    edit(m => addColumn(m, probe, { name: 'b_cd', type: 'varchar(10)', notNull: false }));
    const created = await applyAndCommit();
    openEditor(probe);
    await nextTick(); await frames(5); await sleep(400);
    return { created, after: await diffDev() };
  }
  if (step === 'editor') { openEditor(a!); await nextTick(); await frames(5); await sleep(400); return null; }
  if (step === 'apply') { const r = await applyAndCommit(); return { ...r, after: await diffDev() }; }
  if (step === 'saveTwice') { // b 폴더에 두 번 저장: 두 번째는 다시 쓴 파일이 0 이어야 바이트가 같다. 다시 열어 도메인을 본다
    const first = await saveTo(b!);
    const second = await saveTo(b!);
    await openModel(b!);
    await nextTick(); await frames(5);
    return { first: first?.written.length, second: second?.written, errors: errors.value.map(e => e.message), domains: model.value!.domains, columns: t()?.columns.map(c => `${c.name} ${c.type}${c.domain ? ' %' + c.domain : ''}`) };
  }
  if (step === 'sql') { // dev 에 SQL 한 문장을 실행하고 커밋 (도구 밖에서 DB 가 바뀐 상황 만들기)
    const id = addSql(b!);
    await nextTick(); await frames(5);
    const tab = tabRefs.get(id) as InstanceType<typeof SqlTab>;
    await tab.loadOptions();
    await tab.connect('be:dev');
    tab.editor()!.setValue(b!);
    const r = await tab.runAll();
    await tab.tx('commit');
    await closeTab(tabs.value.find(x => x.id === id)!);
    activeTab.value = 'erd';
    return r;
  }
  if (step === 'reverse') { // 같은 모델 폴더(b)로 dev 를 다시 불러온다
    panel.value!.select('dev');
    await panel.value!.doReverse();
    const p = panel.value!.pending!;
    const out = { warnings: p.warnings.filter(w => w.includes('도메인')), changed: p.diff.changed, columns: p.model.tables.find(x => x.name === probe)?.columns.map(c => `${c.name} ${c.type}${c.domain ? ' %' + c.domain : ''}`) };
    panel.value!.apply();
    return out;
  }
  if (step === 'cleanup') { // 시험 테이블을 지우는 ALTER 를 dev 에 적용
    if (t()) edit(m => dropTable(m, probe));
    const r = await applyAndCommit();
    return { ...r, after: await diffDev() };
  }
  return JSON.parse(JSON.stringify({
    domains: model.value?.domains ?? [], columns: t()?.columns.map(c => `${c.name} ${c.type}${c.domain ? ' %' + c.domain : ''}`), message: message.value,
    badges: Array.from(document.querySelectorAll(`.pane.canvas .split > .pane:first-child .vue-flow__node-table .dom`)).map(e => e.textContent),
    editor: editName.value, domainPanel: domainOpen.value, dialog: dlg.value?.text ?? null,
  }));
};

/** 화면 위치 저장 시험: 'set' 으로 옮기고, 'saveReopen' 으로 dir 에 저장한 뒤 같은 폴더를 다시 열어 화면 위치를 돌려준다 */
window.__erdViewport = async (step: string, arg?: string) => {
  if (step === 'set') { const v = JSON.parse(arg!); canvas.value!.setViewportTo(v); await sleep(400); }
  if (step === 'saveReopen') {
    await saveTo(arg!);
    activeTab.value = 'erd';
    await openModel(arg!);
    await nextTick(); await frames(10); await sleep(800);
  }
  if (step === 'tab') { selectTab(arg!); await nextTick(); await frames(10); await sleep(600); }
  const v = canvas.value!.viewportNow();
  return { x: Math.round(v.x), y: Math.round(v.y), zoom: Math.round(v.zoom * 1000) / 1000, saved: diagram.value?.viewport ?? null, tab: tab.value };
};

/** 저장 미리보기 시험: dir 에 저장 미리보기를 띄운다 (끝을 기다리지 않는다). 메인이 창을 읽고 「저장」 을 누른다 */
window.__erdSavePreview = async (dir: string) => {
  void saveWithPreview({ dir, hasModel: true });
  for (let i = 0; i < 50 && !savePreview.value; i++) await sleep(100);
  return !!savePreview.value;
};

/** 배치 되돌리기 시험 (STEP 10): 메인이 실제 입력으로 옮기고 되돌린 뒤 여기서 위치, 탭, FK 를 읽는다 */
window.__erdUndo = async (step: string, a?: string, b?: string) => {
  const id = (n: string) => model.value!.tables.find(t => t.name === n)?.id ?? '';
  if (step === 'fit') { await canvas.value!.fitView({ nodes: a!.split(',').map(id), padding: 0.3, maxZoom: 1 }); await sleep(700); return null; }
  if (step === 'place') { // 새 테이블 a 를 b 오른쪽에 두고 둘이 보이게 (시험 준비라 되돌리기 기록에 넣지 않는다)
    const box = canvas.value!.boxes().get(id(b!))!;
    diagram.value!.pinned[id(a!)] = [box.x + box.w + 120, box.y];
    version.value++;
    await nextTick(); await frames(5);
    await canvas.value!.fitView({ nodes: [id(a!), id(b!)], padding: 0.3, maxZoom: 1 }); await sleep(700);
    return null;
  }
  const d = diagram.value!;
  const pos = (n: string) => d.pinned[id(n)] ?? null;
  const t = model.value!.tables.find(x => x.name === a);
  return JSON.parse(JSON.stringify({
    canUndo: canUndo.value, canRedo: canRedo.value, tab: tab.value, tabs: tabNames.value, mode: arrangeMode(d), pinned: Object.keys(d.pinned).length,
    pos: a ? pos(a) : null, pos2: b ? pos(b) : null, members: membersOf(tab.value)?.length ?? null,
    table: t ? { columns: t.columns.map(c => c.name), fks: t.fks.map(f => f.name) } : null, hasTable: !!t, message: message.value, ask: !!connectAsk.value,
  }));
};

window.__erdAuto = async ({ scenario, beDir, profile, modelDir: dir, exportDir, measure, dbms, part }) => {
  if (scenario === 'step10') return step10Scenario(beDir, dir, part);
  if (scenario === 'dbms') return dbmsScenario(dir, JSON.parse(dbms ?? '[]'));
  if (scenario === 'password') return passwordScenario(beDir);
  if (scenario === 'suggest') return suggestScenario(beDir);
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
  const saved = await saveTo(dir);
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
      <button title="저장한 ERD 모델 폴더를 엽니다. 폴더 안 파일을 하나 고르세요" @click="openModel()">ERD 폴더 열기</button>
      <button :disabled="!model || !!aiBase" :title="aiBase ? 'AI 변경을 확정하거나 취소한 뒤 저장하세요' : '저장할 폴더를 고르면 바뀔 파일을 먼저 보여 줍니다'" @click="save">ERD 저장{{ dirty ? ' *' : '' }}</button>
      <button :disabled="!model" title="새 테이블을 만들고 편집 패널을 엽니다. 그룹 탭에서 만들면 그 그룹에도 들어갑니다" @click="newTable">새 테이블</button>
      <button :disabled="!canUndo" title="Ctrl+Z" @click="undo">되돌리기</button>
      <button :disabled="!canRedo" title="Ctrl+Y" @click="redo">다시 하기</button>
      <button :disabled="!model" title="모델 전체 CREATE 문을 새 SQL 탭에 넣습니다" @click="createAll">전체 CREATE</button>
      <button :disabled="!model" title="DB 비교 탭에서 지금 ERD 와 DB 를 비교합니다. 적용은 그 탭의 「왼쪽 DB 에 적용」으로 합니다" @click="applyToDb">DB 에 적용</button>
      <button :disabled="!model" title="타입만 정하는 도메인 목록입니다. 도메인 타입을 고치면 쓰는 컬럼이 모두 바뀝니다" @click="openDomains">도메인</button>
      <span class="dir" :title="modelDir">{{ modelDir || 'ERD 폴더 없음' }}</span>
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
      <button :disabled="!model" title="끌어 옮긴 위치를 지우고 고른 정렬 방식대로 다시 놓습니다" @click="autoArrange">자동 정렬</button>
      <label><input v-model="view.compactOnZoomOut" type="checkbox" /> 축소하면 이름만 보기</label>
    </header>
    <div class="app-body">
      <!-- 왼쪽 접속 패널 | 오른쪽(위: ERD, SQL 탭 / 아래: 터미널). 경계선을 끌어 크기를 바꾼다 -->
      <SplitPane dir="row" fixed="first" :initial="300" :min="200" :max="700" storage-key="left">
        <template #first>
          <ConnPanel ref="panel" :model-dir="modelDir" :can-replace="() => discardOk('DB 에서 불러온 것으로 바꾸면')" @apply="applyReverse" @be-dir="onBeDir" />
        </template>
        <template #second>
          <SplitPane dir="col" fixed="second" :initial="280" :min="100" storage-key="terminal" :hide-fixed="!termVisible">
            <template #first>
              <main class="workarea main-top">
                <nav class="tabs">
                  <button v-for="t in tabs" :key="t.id" :class="{ on: t.id === activeTab, erd: t.kind === 'erd' }" :data-tab="t.id"
                          :title="t.kind === 'erd' ? (docs.get(t.id)?.modelDir.value || '빈 ERD 탭') : ''" @click="activeTab = t.id">
                    <template v-if="t.kind === 'erd'">{{ titleOf(t.id) }}<b v-if="docs.get(t.id)?.dirty.value" class="warn"> *</b></template>
                    <template v-else>{{ t.title }}<b v-if="t.dirty" class="warn"> *</b></template>
                    <span v-if="t.kind !== 'erd' || tabs.filter(x => x.kind === 'erd').length > 1" class="x" title="닫기" @click.stop="closeTab(t)">×</span>
                  </button>
                  <button class="add" title="새 ERD 탭 (다른 모델 폴더를 열거나 DB 에서 불러옵니다)" @click="addErd()">+ ERD</button>
                  <button class="add" @click="addSql()">+ SQL</button>
                  <button class="add" @click="openCompare">DB 비교</button>
                  <button class="add" title="MD 문서, 메뉴 물리 테이블 목록을 만듭니다. Flyway 파일은 DB 비교 탭에서 만듭니다" @click="openExport">내보내기</button>
                  <button v-if="selected.length" class="add" @click="addSql(buildJoinSelect(model!, selected))">SELECT 만들기 ({{ selected.length }})</button>
                  <button v-if="selected.length === 1" class="add" @click="openEditor(selected[0])">테이블 편집</button>
                  <span class="spacer" />
                  <button class="add" title="Ctrl+`" @click="toggleTerm">{{ termVisible ? '터미널 숨기기 ▾' : '터미널 ▴' }}</button>
                </nav>
                <div v-show="isErd(activeTab)" class="pane canvas">
                  <div v-if="aiBase" class="ai-bar">
                    AI 변경 <b>{{ aiChanged.size }}</b>개 테이블 확정 대기 (주황 테두리)
                    <button @click="aiConfirm">확정</button>
                    <button @click="aiCancel">취소</button>
                  </div>
                  <!-- 테이블을 더블클릭하면 오른쪽에 미니 ERD 가 열린다 (그 테이블과 FK 로 바로 이어진 테이블만) -->
                  <div class="erd-area">
                  <SplitPane dir="row" fixed="second" :initial="560" :min="260" storage-key="mini" :hide-fixed="!miniName && !editName && !domainOpen">
                    <template #first>
                      <ErdCanvas v-if="model && diagram && shown" :key="cur.id" ref="canvas" :initial-viewport="cur.viewport ?? diagram.viewport" :saved-viewport="diagram.viewport" :model="shown.model" :external="shown.external" :diagram="diagram" :version="version" :fit-key="fitKey" :highlight="aiChanged"
                                 @pin="onPin" @select="onSelect" @open="n => { editId = ''; miniName = n; }" @menu="onMenu"
                                 connectable :can-connect="canConnect" @connect="onConnectTables" @pane-click="view.colSel = []" @select-fks="f => (selectedFks = f)" />
                      <p v-else class="empty">왼쪽에서 DB 를 불러오거나, 위에서 ERD 폴더를 여세요.</p>
                    </template>
                    <template #second>
                      <TableEditor v-if="model && editName" ref="editor" :model="model" :name="editName" @edit="edit" @close="editId = ''" />
                      <DomainPanel v-else-if="model && domainOpen" ref="domainPanel" :model="model" @edit="edit" @remove="removeDomain" @close="domainOpen = false" />
                      <section v-else-if="model && miniName" class="mini">
                        <header>
                          <b>{{ miniName }}</b>
                          <span class="muted">와 바로 이어진 테이블 {{ miniModel!.tables.length - 1 }}개. 더블클릭하면 그 테이블 기준으로 바뀝니다</span>
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
                  <DiagramTabs v-if="model" :all="DEFAULT_DIAGRAM" :tabs="tabNames" :active="tab" :can-prefix="!tabNames.length"
                               @select="selectTab" @add="addTab" @rename="onRenameTab" @remove="onRemoveTab" @prefix="onPrefixTabs" @pick="pickOpen = true" />
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
    <div v-if="menu" class="ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @contextmenu.prevent>
      <template v-if="menu.names.length">
        <div class="ctx-title">{{ menu.names.length === 1 ? menu.names[0] : `테이블 ${menu.names.length}개` }}</div>
        <div class="ctx-sub">그룹에 추가</div>
        <button v-for="g in menuGroups" :key="g" class="ind" @click="runMenu(n => addToGroup(n, g))">{{ g }}</button>
        <button class="ind" @click="runMenu(newGroupWith)">새 그룹 만들어 추가</button>
        <button v-if="tab !== DEFAULT_DIAGRAM" @click="runMenu(removeFromGroup)">이 그룹에서 빼기 (모델에는 남김)</button>
        <button v-if="menu.names.length === 1" @click="runMenu(n => openEditor(n[0]))">테이블 편집</button>
        <button class="danger" @click="runMenu(deleteTables)">모델에서 삭제 (Delete)</button>
      </template>
      <template v-else>
        <button v-if="tab !== DEFAULT_DIAGRAM" @click="runMenu(() => (pickOpen = true))">테이블 추가 (이 그룹에 없는 테이블)</button>
        <button @click="runMenu(() => newTable())">새 테이블</button>
      </template>
    </div>
    <TablePickDialog v-if="pickOpen" ref="picker" :group="tab" :tables="pickTables" @pick="onPick" @close="pickOpen = false" />
    <div v-if="connectAsk" class="modal" @keydown.esc="answerConnect(false)">
      <form class="dialog conn" @submit.prevent="answerConnect(true)">
        <p><b>FK 만들기</b>: {{ connectAsk.plan.child }} → {{ connectAsk.plan.parent }}({{ connectAsk.plan.parentColumn }} {{ connectAsk.plan.parentType }})</p>
        <label>FK 이름 <input v-model="connectAsk.fkName" spellcheck="false" /></label>
        <label>{{ connectAsk.plan.child }} 컬럼
          <select v-model="connectAsk.childColumn">
            <option :value="NEW_COL">새 컬럼 {{ connectAsk.plan.newColumn }} ({{ connectAsk.plan.parentType }}, NULL 허용)</option>
            <option v-for="c in connectAsk.plan.childOptions" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }}){{ c.type !== connectAsk.plan.parentType ? ' 타입 다름' : '' }}</option>
          </select>
        </label>
        <label>ON DELETE
          <select v-model="connectAsk.onDelete">
            <option value="">NO ACTION (기본)</option>
            <option value="restrict">RESTRICT</option>
            <option value="cascade">CASCADE</option>
            <option value="set null">SET NULL</option>
            <option value="set default">SET DEFAULT</option>
          </select>
        </label>
        <div class="row">
          <button type="submit" :disabled="!connectAsk.fkName.trim()">만들기</button>
          <button type="button" @click="answerConnect(false)">취소</button>
        </div>
      </form>
    </div>
    <div v-if="savePreview" class="modal" @keydown.esc="answerSave(false)">
      <div class="dialog save-preview">
        <p><b>ERD 저장</b> <span class="muted">{{ savePreview.dir }}</span></p>
        <p v-if="savePreview.otherModel" class="warn">이 폴더에는 다른 ERD 모델이 있습니다. 이 모델로 덮어씁니다.</p>
        <p v-if="!savePreview.plan.added.length && !savePreview.plan.changed.length && !savePreview.plan.removed.length">바뀌는 파일이 없습니다 (그대로 {{ savePreview.plan.unchanged.length }}개).</p>
        <template v-for="g in [
          { key: 'added', label: '새로 만듦', cls: 'ok' },
          { key: 'changed', label: '바뀜', cls: '' },
          { key: 'removed', label: '삭제 (이 모델에 없는 모델 파일)', cls: 'warn' },
          { key: 'unchanged', label: '그대로', cls: 'muted' },
        ] as const" :key="g.key">
          <div v-if="savePreview.plan[g.key].length" class="sp-group" :data-kind="g.key">
            <div :class="g.cls"><b>{{ g.label }} {{ savePreview.plan[g.key].length }}개</b></div>
            <ul><li v-for="f in savePreview.plan[g.key]" :key="f">{{ f }}</li></ul>
          </div>
        </template>
        <div class="row">
          <button @click="answerSave(true)">저장</button>
          <button @click="answerSave(false)">취소</button>
        </div>
      </div>
    </div>
    <div v-if="dlg" class="modal">
      <div class="dialog ask">
        <p>{{ dlg.text }}</p>
        <div class="row">
          <button v-for="b in dlg.buttons" :key="b.label" @click="answerDlg(b.value)">{{ b.label }}</button>
        </div>
      </div>
    </div>
    <div v-if="closeAsk" class="modal">
      <div class="dialog">
        <p>커밋하지 않은 변경이 있습니다: <b>{{ closeAsk.labels.join(', ') }}</b></p>
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
/* 전역 클래스 이름은 Monaco(SQL 편집기) 안의 .main, .body 와 겹치지 않게 짓는다. 겹치면 자동완성 글자가 줄 밖으로 밀려 안 보였다 (2026-10-16) */
.app-body { flex: 1; display: flex; min-height: 0; }
.workarea { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
.tabs { display: flex; gap: 2px; align-items: flex-end; padding: 4px 6px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tabs button { border: 1px solid var(--line); border-bottom: none; background: var(--panel-bg); color: var(--fg); padding: 4px 10px; cursor: pointer; }
.tabs button.on { background: var(--bg); font-weight: bold; border-color: var(--accent); }
.tabs .add { background: transparent; border-style: dashed; border-bottom-style: none; } /* border-style 이 아래 테두리를 굵은 점선으로 되살리지 않게 */
.tabs .x { margin-left: 6px; color: var(--muted); }
/* 위 영역 탭줄: 탭과 탭 여는 버튼을 모두 같은 크기 사각형으로 (사용자 요청 2026-10-16). 왼쪽 접속 패널의 .tabs 는 건드리지 않는다 */
/* 모양은 그대로 아래 화면에 붙은 탭(아래 테두리 없음)이고, 고른 탭은 탭줄 아래 선을 덮어 화면과 이어진다 */
.workarea > .tabs button { box-sizing: border-box; flex: none; width: 112px; height: 24px; padding: 0 4px; font-size: 12px; /* 가장 긴 「SELECT 만들기 (1)」 이 잘리지 않는 폭 */
  display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; overflow: hidden; }
.workarea > .tabs button.on { margin-bottom: -1px; height: 25px; }
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
.ag-cell.is-null { color: var(--muted); font-style: italic; }
.pane.canvas { display: flex; flex-direction: column; }
.erd-area { flex: 1; min-height: 0; position: relative; }
.dialog.ask p { white-space: pre-line; margin-top: 0; }
.save-preview { min-width: 420px; max-height: 80vh; display: flex; flex-direction: column; gap: 6px; }
.save-preview p { margin: 0; word-break: break-all; }
.save-preview .sp-group { font-size: 12px; }
.save-preview ul { margin: 2px 0 0; padding-left: 18px; max-height: 140px; overflow: auto; font: 12px Consolas, 'Malgun Gothic', monospace; }
.save-preview .ok { color: var(--ok); } .save-preview .muted { color: var(--muted); }
.dialog.conn { display: flex; flex-direction: column; gap: 8px; min-width: 420px; }
.dialog.conn p { margin: 0; }
.dialog.conn label { display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 8px; font-size: 12px; }
.dialog.conn input, .dialog.conn select { color: var(--fg); background: var(--bg); border: 1px solid var(--line); padding: 2px 4px; font: 12px Consolas, 'Malgun Gothic', monospace; }
.ctx { position: fixed; z-index: 60; min-width: 200px; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); padding: 3px 0; font-size: 12px; }
.ctx button { text-align: left; border: none; background: transparent; color: var(--fg); padding: 3px 12px; cursor: pointer; }
.ctx button:hover { background: var(--sel-bg); }
.ctx .ind { padding-left: 24px; }
.ctx .danger { color: var(--warn); }
.ctx-title { padding: 2px 12px 4px; font-weight: bold; border-bottom: 1px solid var(--line); margin-bottom: 2px; }
.ctx-sub { padding: 2px 12px; color: var(--muted); }
.warn { color: var(--warn); }
</style>
