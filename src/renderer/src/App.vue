<script setup lang="ts">
// 화면: 왼쪽 접속 패널, 가운데 ERD 캔버스. 위: 모델 폴더, 저장, 보기 모드, 자동 정렬.
import { nextTick, provide, reactive, ref, shallowRef } from 'vue';
import ConnPanel from './components/ConnPanel.vue';
import ErdCanvas from './components/ErdCanvas.vue';
import SqlTab from './components/SqlTab.vue';
import TerminalTab from './components/TerminalTab.vue';
import { buildJoinSelect } from '../../shared/sql/join';
import { DEFAULT_DIAGRAM, syncLayout } from '../../shared/model/arrange';
import { emptyLayout, type Diagram, type Layout } from '../../shared/model/layout';
import type { ModelError, SchemaModel } from '../../shared/model/types';
import type { ReverseResult, ShellKind } from '../../shared/ipc';
import { VIEW_KEY, type ViewState } from './view';

const view = reactive<ViewState>({ nameMode: 'both', compactOnZoomOut: false, compact: false });
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

// ---------- 탭: ERD, SQL, 터미널 ----------
interface Tab { id: string; kind: 'erd' | 'sql' | 'term'; title: string; dirty: boolean; initialSql?: string; shell?: ShellKind }
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

function addTerm(shell: ShellKind) {
  const id = `term-${++seq}`;
  tabs.value.push({ id, kind: 'term', title: shell === 'pwsh' ? `PowerShell ${seq}` : `Git Bash ${seq}`, dirty: false, shell });
  activeTab.value = id;
  return id;
}

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

  // 자동완성: 별칭 b. 뒤 컬럼
  ed.setValue('select * from mst_biz b where b.');
  ed.setPosition({ lineNumber: 1, column: 33 });
  ed.focus();
  ed.trigger('auto', 'editor.action.triggerSuggest', {});
  await sleep(800);
  out.suggest = Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).slice(0, 4).map(r => r.getAttribute('aria-label'));
  ed.trigger('auto', 'hideSuggestWidget', {});

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

  // 터미널: PowerShell 7 에서 claude --version, 한글 폭
  const tid = addTerm('pwsh');
  await nextTick(); await sleep(3000);
  const term = tabRefs.get(tid) as InstanceType<typeof TerminalTab>;
  term.write('claude --version\r');
  await sleep(8000);
  term.write('echo 가나다ABC\r');
  await sleep(1500);
  const buf = term.bufferText();
  out.terminal = { claude: /\(Claude Code\)/.test(buf), korean: buf.includes('가나다ABC'), tail: buf.split('\n').slice(-6) };
  // 실행 중에 터미널 탭 하나를 닫아도 오류가 없어야 한다
  const t2 = addTerm('bash');
  await nextTick(); await sleep(2500);
  await closeTab(tabs.value.find(t => t.id === t2)!);
  await sleep(1500);
  out.tabs = { sql: id, term: tid };
  activeTab.value = id;
  return JSON.parse(JSON.stringify(out)); // 반응형 값이 섞여 있어 평범한 값으로 바꿔 돌려준다
}

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
      <button :disabled="!model" @click="autoArrange">자동 정렬</button>
      <label><input v-model="view.compactOnZoomOut" type="checkbox" /> 축소하면 이름만 보기</label>
    </header>
    <div class="body">
      <ConnPanel ref="panel" :model-dir="modelDir" @apply="applyReverse" @be-dir="onBeDir" />
      <main class="main">
        <nav class="tabs">
          <button v-for="t in tabs" :key="t.id" :class="{ on: t.id === activeTab }" @click="activeTab = t.id">
            {{ t.title }}<b v-if="t.dirty" class="warn"> *</b>
            <span v-if="t.kind !== 'erd'" class="x" title="닫기" @click.stop="closeTab(t)">×</span>
          </button>
          <button class="add" @click="addSql()">+ SQL</button>
          <button class="add" @click="addTerm('pwsh')">+ PowerShell</button>
          <button class="add" @click="addTerm('bash')">+ Git Bash</button>
          <button v-if="selected.length" class="add" @click="addSql(buildJoinSelect(model!, selected))">SELECT 만들기 ({{ selected.length }})</button>
        </nav>
        <div v-show="activeTab === 'erd'" class="pane canvas">
          <ErdCanvas v-if="model && diagram" ref="canvas" :model="model" :diagram="diagram" :version="version" @pin="onPin" @select="n => (selected = n)" />
          <p v-else class="empty">왼쪽에서 DB 를 불러오거나, 위에서 모델 폴더를 여세요.</p>
        </div>
        <div v-for="t in tabs.filter(x => x.kind !== 'erd')" v-show="activeTab === t.id" :key="t.id" class="pane">
          <SqlTab v-if="t.kind === 'sql'" :ref="el => setTabRef(t.id, el)" :tab-id="t.id" :schema="model" :initial-sql="t.initialSql"
                  :active="activeTab === t.id" @state="s => (t.dirty = !!s?.dirty)" />
          <TerminalTab v-else :ref="el => setTabRef(t.id, el)" :term-id="t.id" :shell="t.shell!" :active="activeTab === t.id" />
        </div>
      </main>
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
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.tabs { display: flex; gap: 2px; padding: 4px 6px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tabs button { border: 1px solid var(--line); border-bottom: none; background: var(--panel-bg); color: var(--fg); padding: 4px 10px; cursor: pointer; }
.tabs button.on { background: var(--bg); font-weight: bold; border-color: var(--accent); }
.tabs .add { background: transparent; border-style: dashed; }
.tabs .x { margin-left: 6px; color: var(--muted); }
.pane { flex: 1; min-height: 0; position: relative; }
.canvas { position: relative; }
.modal { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
.dialog { background: var(--bg); border: 1px solid var(--line); padding: 16px; max-width: 480px; }
.dialog .row { display: flex; gap: 8px; justify-content: flex-end; }
.empty { padding: 24px; color: var(--muted); }
.warn { color: var(--warn); }
</style>
