<script setup lang="ts">
// 화면: 왼쪽 접속 패널, 가운데 ERD 캔버스. 위: 모델 폴더, 저장, 보기 모드, 자동 정렬.
import { computed, nextTick, provide, reactive, ref, shallowRef, watch } from 'vue';
import ConnPanel from './components/ConnPanel.vue';
import ErdCanvas from './components/ErdCanvas.vue';
import SqlTab from './components/SqlTab.vue';
import TerminalPanel from './components/TerminalPanel.vue';
import SplitPane from './components/SplitPane.vue';
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

window.erd.settings.get().then(s => { if (s.modelDir) modelDir.value = s.modelDir; });

function show(m: SchemaModel, l: Layout) {
  model.value = m;
  layout.value = l;
  diagram.value = syncLayout(m, l, DEFAULT_DIAGRAM);
  version.value++;
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

// ---------- 위 영역 탭: ERD, SQL / 아래 영역: 터미널 ----------
interface Tab { id: string; kind: 'erd' | 'sql'; title: string; dirty: boolean; initialSql?: string }
const tabs = ref<Tab[]>([{ id: 'erd', kind: 'erd', title: 'ERD', dirty: false }]);
const activeTab = ref('erd');
const selected = ref<string[]>([]);
const tabRefs = new Map<string, unknown>();
const setTabRef = (id: string, el: unknown) => { if (el) tabRefs.set(id, el); else tabRefs.delete(id); };
let seq = 0;

function addSql(initialSql = '') {
  const id = `sql-${++seq}`;
  tabs.value.push({ id, kind: 'sql', title: `SQL ${seq}`, dirty: false, initialSql });
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

window.__erdAuto = async ({ scenario, beDir, profile, modelDir: dir }) => {
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
                  <button v-if="selected.length" class="add" @click="addSql(buildJoinSelect(model!, selected))">SELECT 만들기 ({{ selected.length }})</button>
                  <span class="spacer" />
                  <button class="add" title="Ctrl+`" @click="toggleTerm">{{ termVisible ? '터미널 숨기기 ▾' : '터미널 ▴' }}</button>
                </nav>
                <div v-show="activeTab === 'erd'" class="pane canvas">
                  <!-- 테이블을 더블클릭하면 오른쪽에 미니 ERD 가 열린다 (그 테이블과 FK 로 바로 이어진 테이블만) -->
                  <SplitPane dir="row" fixed="second" :initial="560" :min="260" storage-key="mini" :hide-fixed="!miniName">
                    <template #first>
                      <ErdCanvas v-if="model && diagram" ref="canvas" :model="model" :diagram="diagram" :version="version"
                                 @pin="onPin" @select="n => (selected = n)" @open="n => (miniName = n)" />
                      <p v-else class="empty">왼쪽에서 DB 를 불러오거나, 위에서 모델 폴더를 여세요.</p>
                    </template>
                    <template #second>
                      <section v-if="model && miniName" class="mini">
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
                  <SqlTab :ref="el => setTabRef(t.id, el)" :tab-id="t.id" :schema="model" :initial-sql="t.initialSql"
                          :active="activeTab === t.id" @state="s => (t.dirty = !!s?.dirty)" />
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
