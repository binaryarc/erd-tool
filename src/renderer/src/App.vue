<script setup lang="ts">
// 화면: 왼쪽 접속 패널, 가운데 ERD 캔버스. 위: 모델 폴더, 저장, 보기 모드, 자동 정렬.
import { computed, nextTick, provide, reactive, ref, watch } from 'vue';
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
import PasswordDialog from './components/PasswordDialog.vue';
import GroupContextMenu from './components/GroupContextMenu.vue';
import ConnectDialog from './components/ConnectDialog.vue';
import SavePreviewDialog from './components/SavePreviewDialog.vue';
import AskDialog from './components/AskDialog.vue';
import CloseConfirmDialog from './components/CloseConfirmDialog.vue';
import { addTable, domainUsage, dropDomain, dropFk, pasteColumns } from '../../shared/model/edit';
import { applyConnect, planConnect, type ConnectPlan, type End } from '../../shared/model/connect';
import type { Column, FkAction } from '../../shared/model/types';
import { columnText } from '../../shared/model/erd-format';
import { addMembers, forgetIds } from '../../shared/model/group-tabs';
import { buildCreateAll } from '../../shared/sql/create';
import { buildJoinSelect } from '../../shared/sql/join';
import { DEFAULT_DIAGRAM } from '../../shared/model/arrange';
import { arrangeMode, type Diagram } from '../../shared/model/layout';
import { VIEW_KEY, colKey, loadPref, savePref, type ViewState } from './view';
import { neighborhood } from '../../shared/model/tree';
import { useErdDocs } from './composables/useErdDocs';
import { useTopTabs } from './composables/useTopTabs';
import { useGroupTabs } from './composables/useGroupTabs';
import { useModelFiles } from './composables/useModelFiles';
import { useAi } from './composables/useAi';
import { useSession } from './composables/useSession';

const view = reactive<ViewState>({
  nameMode: loadPref('nameMode', 'both', ['physical', 'logical', 'both'] as const),
  // 선 모양 기본값은 직선 (사용자 지정 2026-10-16). 이 PC 에서 고른 적이 있으면 그것을 쓴다
  edgeKind: loadPref('edgeKind', 'straight', ['smoothstep', 'straight', 'default'] as const),
  compactOnZoomOut: false, compact: false, colSel: [],
});
watch(() => view.nameMode, v => savePref('nameMode', v));
watch(() => view.edgeKind, v => savePref('edgeKind', v));
provide(VIEW_KEY, view);

const NL = '\n';
const panel = ref<InstanceType<typeof ConnPanel>>();

// 상태와 기능은 composables/ 에 나눠 둔다 (2026-10-22). 여기서는 묶고 화면과 키보드를 잇는다
const core = useErdDocs();
const { docs, cur, modelDir, model, layout, diagram, version, errors, dirty, fitKey, message, canvas, tab, tabNames, membersOf, shown, refreshDiagram, canUndo, canRedo, editId, editName, edit, undo, redo, pickId, aiBase, miniName, selected } = core;
const top = useTopTabs(core, id => { if (aiTab.value === id) aiTab.value = null; });
const { dlg, askDlg, answerDlg, tabs, activeTab, isErd, titleOf, addErd, setTabRef, openCompare, openExport, addSql, terminals, termVisible, toggleTerm, pwAsk, pwInput, answerPw, closeAsk, answerClose, closeTab } = top;
const groups = useGroupTabs(core, top);
const { onPin, autoArrange, setArrangeMode, selectTab, addTab, onRenameTab, onRemoveTab, onPrefixTabs, addToGroup, newGroupWith, removeFromGroup, deleteTables, menu, onMenu, menuGroups, runMenu, pickOpen, pickTables, onPick } = groups;
const files = useModelFiles(core, top);
const { onBeDir, discardOk, openModel, applyReverse, save, savePreview, answerSave } = files;
const ai = useAi(core, top, groups);
const { aiChanged, aiConfirm, aiCancel, aiTab, releaseAiTab } = ai;
const session = useSession(core, top);

function openEditor(name: string) {
  const t = model.value?.tables.find(x => x.name === name);
  if (!t) return;
  miniName.value = '';
  editId.value = t.id;
  pickId.value = t.id;
}

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


// 미니 ERD: 더블클릭한 테이블과 FK 로 바로 이어진 테이블만, 항상 트리로
const miniModel = computed(() => (model.value && miniName.value ? neighborhood(model.value, miniName.value) : null));
const miniDiagram: Diagram = { mode: 'tree', pinned: {} };
const mini = ref<InstanceType<typeof ErdCanvas>>();
const compare = ref<InstanceType<typeof CompareTab>>();
const editor = ref<InstanceType<typeof TableEditor>>();
const picker = ref<InstanceType<typeof TablePickDialog>>();
const exporter = ref<InstanceType<typeof ExportTab>>();

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

// 시험 모드(ERD_AUTO) 함수는 auto/ 에 있다. 설치용 빌드에서는 __ERD_AUTO__ 가 false 라 이 줄과 그 파일이 빠진다
if (__ERD_AUTO__) void import('./auto').then(m => m.install({ ...core, ...top, ...groups, ...files, ...ai, ...session, view, panel, compare, editor, exporter, mini, domainPanel, domainOpen, miniModel, connectAsk, selectedFks, applyToDb, newTable, openEditor }));
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
                    <template v-if="t.kind === 'erd'">{{ titleOf(t.id) }}<b v-if="docs.get(t.id)?.dirty.value" class="warn"> *</b><span v-if="aiTab === t.id" class="ai-link" title="AI 도구가 이 탭에만 적용됩니다. 확정 대기 중인 변경이 없으면 눌러서 풉니다" @click.stop="releaseAiTab"> AI 연결</span></template>
                    <template v-else>{{ t.title }}<b v-if="t.dirty" class="warn"> *</b></template>
                    <span v-if="t.kind !== 'erd' || tabs.filter(x => x.kind === 'erd').length > 1" class="x" title="닫기" @click.stop="closeTab(t)">×</span>
                  </button>
                  <button class="add" title="새 ERD 탭 (다른 모델 폴더를 열거나 DB 에서 불러옵니다)" @click="addErd()">+ ERD</button>
                  <button class="add" @click="addSql()">+ SQL</button>
                  <button class="add" @click="openCompare">DB 비교</button>
                  <button class="add" title="MD 문서, 고른 테이블 목록을 만듭니다. Flyway 파일은 DB 비교 탭에서 만듭니다" @click="openExport">내보내기</button>
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
    <PasswordDialog v-if="pwAsk" :ask="pwAsk" :input="pwInput" @answer="answerPw" />
    <GroupContextMenu v-if="menu" :menu="menu" :groups="menuGroups" :tab="tab"
                      @add-to-group="g => runMenu(n => addToGroup(n, g))" @new-group="runMenu(newGroupWith)" @remove-from-group="runMenu(removeFromGroup)"
                      @edit="runMenu(n => openEditor(n[0]))" @remove="runMenu(deleteTables)" @pick-tables="runMenu(() => (pickOpen = true))" @new-table="runMenu(() => newTable())" />
    <TablePickDialog v-if="pickOpen" ref="picker" :group="tab" :tables="pickTables" @pick="onPick" @close="pickOpen = false" />
    <ConnectDialog v-if="connectAsk" :ask="connectAsk" :new-col="NEW_COL" @answer="answerConnect" />
    <SavePreviewDialog v-if="savePreview" :preview="savePreview" @answer="answerSave" />
    <AskDialog v-if="dlg" :dlg="dlg" @answer="answerDlg" />
    <CloseConfirmDialog v-if="closeAsk" :ask="closeAsk" @answer="answerClose" />
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
.tabs .ai-link { margin-left: 6px; padding: 0 4px; font-size: 11px; font-weight: normal; color: #f08c00; border: 1px solid #f08c00; border-radius: 3px; }
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
.warn { color: var(--warn); }
</style>
