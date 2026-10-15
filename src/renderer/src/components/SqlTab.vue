<script setup lang="ts">
// SQL 탭 (설계 5장, 9장): 위 Monaco, 아래 AG Grid. 탭마다 전용 연결, 자동 커밋 끔, 결과 1,000행씩.
// 실행: Ctrl+Enter — 선택 영역이 있으면 그것만, 없으면 커서가 있는 문장.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { AgGridVue } from 'ag-grid-vue3';
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz, type ColDef, type GridApi } from 'ag-grid-community';
import { bindContext, catalogCache, catalogFromModel, monaco, registerSqlProviders, unbindContext } from '../sql/monaco';
import SplitPane from './SplitPane.vue';
import { statementAt } from '../../../shared/sql/text';
import type { ConnRef, HistoryEntry, SqlCatalog, SqlResult, SqlState } from '../../../shared/ipc';
import type { SchemaModel } from '../../../shared/model/types';

ModuleRegistry.registerModules([AllCommunityModule]);
const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
// 결과를 많이 보이게 촘촘하게 (사용자 요청): 글자 12px, 행 22px, 머리글 26px
const compact = { fontSize: 12, dataFontSize: 12, headerFontSize: 12, spacing: 4, rowHeight: 22, headerHeight: 26, cellHorizontalPadding: 6 };
const theme = (dark ? themeQuartz.withPart(colorSchemeDark) : themeQuartz).withParams(compact);

const props = defineProps<{ tabId: string; schema: SchemaModel | null; initialSql?: string; active: boolean }>();
const emit = defineEmits<{ state: [s: SqlState | null] }>();

interface ConnOption { key: string; label: string; ref: ConnRef; readOnly: boolean }
// ref 값을 IPC 로 보내므로 Vue 반응형으로 감싸지 않는다 (감싸면 복사 오류)
const options = shallowRef<ConnOption[]>([]);
const chosen = ref('');
const state = ref<SqlState | null>(null);
const result = shallowRef<SqlResult | null>(null);
const busy = ref(false);
const message = ref('');
const history = shallowRef<HistoryEntry[]>([]);
// 자동완성용 DB 목록. 접속할 때 그 DB 에서 읽는다 (같은 접속은 다시 읽지 않음, 「목록 새로 읽기」로 갱신)
const catalog = shallowRef<SqlCatalog | null>(null);
const catalogMessage = ref('');
const editorEl = ref<HTMLDivElement>();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
const grid = shallowRef<GridApi | null>(null);
const fetched = ref(0);

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function loadOptions() {
  const s = await window.erd.settings.get();
  const be = s.beDir ? (await window.erd.conn.list(s.beDir)).map(p => ({
    key: 'be:' + p.name, label: `${p.name} (${p.database})`, readOnly: p.readOnly,
    ref: { source: 'be', beDir: s.beDir!, name: p.name } as ConnRef,
  })) : [];
  const manual = (await window.erd.manual.list()).map(c => ({
    key: 'manual:' + c.id, label: `${c.name} (${c.database})`, readOnly: c.readOnly, ref: { source: 'manual', id: c.id } as ConnRef,
  }));
  options.value = [...be, ...manual];
  if (!chosen.value) chosen.value = (be.find(o => o.key === 'be:dev') ?? options.value[0])?.key ?? '';
}

async function connect(key = chosen.value) {
  const o = options.value.find(x => x.key === key);
  if (!o) return;
  if (state.value?.dirty && !confirm('커밋 안 한 변경이 있다. 롤백하고 다른 접속으로 바꿀까요?')) return;
  busy.value = true; message.value = '';
  try {
    state.value = await window.erd.sql.open(props.tabId, o.ref, o.label);
    chosen.value = key;
    history.value = await window.erd.history.list(state.value.connKey);
    void loadCatalog(o.ref, state.value.connKey);
    message.value = `${o.label} 접속${state.value.readOnly ? ' (읽기 전용)' : ''}`;
  } catch (e) { message.value = clean(e); state.value = null; }
  finally { busy.value = false; emit('state', state.value); }
}

async function loadCatalog(ref: ConnRef, key: string, refresh = false) {
  const cached = catalogCache.get(key);
  if (cached && !refresh) { catalog.value = cached; return; }
  try {
    catalog.value = await window.erd.db.catalog(ref);
    catalogCache.set(key, catalog.value);
    catalogMessage.value = `자동완성: 테이블 ${catalog.value.tables.length}, 함수 ${catalog.value.functions.length}`;
  } catch (e) { catalogMessage.value = '자동완성 목록을 못 읽음: ' + clean(e); }
}

function reloadCatalog() {
  const o = options.value.find(x => x.key === chosen.value);
  if (o && state.value) void loadCatalog(o.ref, state.value.connKey, true);
}

const columnDefs = computed<ColDef[]>(() => (result.value?.columns ?? []).map((c, i) => ({
  headerName: c.name, colId: 'c' + i, valueGetter: p => (p.data as unknown[])[i], resizable: true, sortable: false,
  cellClass: 'cell', minWidth: 60,
})));

/** 결과 반영 (오류면 편집기에 표시) */
function show(r: SqlResult, sqlStart = 0) {
  state.value = r.state; emit('state', r.state);
  const model = editor!.getModel()!;
  monaco.editor.setModelMarkers(model, 'sql', []);
  if (r.error) {
    message.value = `오류 ${r.error.code ?? ''}: ${r.error.message}`;
    if (r.error.position) {
      const p = model.getPositionAt(sqlStart + r.error.position - 1);
      monaco.editor.setModelMarkers(model, 'sql', [{ severity: monaco.MarkerSeverity.Error, message: r.error.message,
        startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column + 1 }]);
    }
    return;
  }
  if (r.columns.length) {
    result.value = r; fetched.value = r.rows.length;
    message.value = `${r.rows.length}행${r.state.more ? ' (더 있음)' : ''}, ${r.ms}ms`;
  } else {
    message.value = `${r.command}${r.rowCount !== null ? ` ${r.rowCount}행` : ''}, ${r.ms}ms`;
  }
}

async function run(sqlText?: string) {
  if (!state.value) await connect();
  if (!state.value || !editor) return;
  const model = editor.getModel()!;
  let sql = sqlText ?? '', start = 0;
  if (!sqlText) {
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) { sql = model.getValueInRange(sel); start = model.getOffsetAt(sel.getStartPosition()); }
    else {
      const st = statementAt(model.getValue(), model.getOffsetAt(editor.getPosition()!));
      if (!st) return;
      sql = st.text; start = st.start;
    }
  }
  if (!sql.trim()) return;
  busy.value = true;
  try {
    const r = await window.erd.sql.run(props.tabId, sql);
    show(r, start);
    if (!r.error) history.value = await window.erd.history.list(r.state.connKey);
  } catch (e) { message.value = clean(e); }
  finally { busy.value = false; }
  return result.value;
}

async function more() {
  busy.value = true;
  try {
    const r = await window.erd.sql.fetchMore(props.tabId);
    grid.value?.applyTransaction({ add: r.rows });
    fetched.value += r.rows.length;
    state.value = r.state; emit('state', r.state);
    message.value = `${fetched.value}행${r.state.more ? ' (더 있음)' : ''}`;
  } finally { busy.value = false; }
}

async function tx(kind: 'commit' | 'rollback') {
  const r = await window.erd.sql[kind](props.tabId);
  show(r);
}

async function allowWrite() {
  if (!confirm('이 탭에서 쓰기를 허용할까요? 읽기 전용 접속(운영 등)의 데이터를 바꿀 수 있게 된다. 열린 트랜잭션은 롤백한다.')) return;
  state.value = await window.erd.sql.allowWrite(props.tabId);
  emit('state', state.value);
  message.value = '이 탭에서 쓰기 허용됨';
}

onMounted(async () => {
  registerSqlProviders();
  editor = monaco.editor.create(editorEl.value!, {
    value: props.initialSql ?? '', language: 'sql', automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
    inlineSuggest: { enabled: true },
    // 글자를 치는 대로 목록을 연다 (DBeaver 처럼). 편집기 안 단어로 만든 추천은 끈다
    quickSuggestions: { other: true, comments: false, strings: false }, quickSuggestionsDelay: 50,
    wordBasedSuggestions: 'off', suggestOnTriggerCharacters: true, suggest: { showWords: false, preview: true },
    theme: dark ? 'vs-dark' : 'vs', scrollBeyondLastLine: false,
  });
  bindContext(editor.getModel()!, {
    catalog: () => catalog.value ?? (props.schema ? catalogFromModel(props.schema) : null),
    history: () => history.value,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run());
  await loadOptions();
});

watch(() => props.active, a => { if (a) setTimeout(() => editor?.focus(), 0); });

onBeforeUnmount(() => {
  const m = editor?.getModel();
  if (m) unbindContext(m);
  editor?.dispose();
});

defineExpose({
  run, connect, tx, allowWrite, loadOptions,
  state: () => state.value,
  message: () => message.value,
  options: () => options.value.map(o => o.key),
  /** 시험용 */
  editor: () => editor,
  catalogSize: () => catalog.value?.tables.length ?? 0,
  grid: () => ({ rows: grid.value?.getDisplayedRowCount() ?? 0, cols: columnDefs.value.length }),
});
</script>

<template>
  <div class="sql">
    <div class="toolbar">
      <select v-model="chosen" :disabled="busy" @change="connect()">
        <option v-for="o in options" :key="o.key" :value="o.key">{{ o.label }}{{ o.readOnly ? ' [읽기 전용]' : '' }}</option>
      </select>
      <button :disabled="busy" @click="connect()">{{ state ? '다시 접속' : '접속' }}</button>
      <button :disabled="busy" title="Ctrl+Enter" @click="run()">실행</button>
      <button :disabled="busy || !state?.inTx" @click="tx('commit')">커밋</button>
      <button :disabled="busy || !state?.inTx" @click="tx('rollback')">롤백</button>
      <button v-if="state?.readOnly" :disabled="busy" @click="allowWrite">쓰기 허용</button>
      <button v-if="state?.more" :disabled="busy" @click="more">1,000행 더</button>
      <button :disabled="busy || !state" title="테이블을 새로 만들었으면 눌러 자동완성 목록을 다시 읽는다" @click="reloadCatalog">목록 새로 읽기</button>
      <span class="status">
        <b v-if="state?.dirty" class="warn">커밋 안 함</b>
        <span v-else-if="state?.inTx">트랜잭션 진행 중</span>
        <span v-if="state?.readOnly" class="ro">읽기 전용</span>
        {{ message }}
        <span class="muted">{{ catalogMessage }}</span>
      </span>
    </div>
    <!-- 편집기와 결과 사이 경계선을 끌어 높이를 바꾼다 -->
    <SplitPane dir="col" fixed="first" :initial="260" :min="80" storage-key="sql-editor" class="split">
      <template #first>
        <div ref="editorEl" class="editor" />
      </template>
      <template #second>
        <div class="result">
          <AgGridVue v-if="result?.columns.length" class="grid" :theme="theme" :column-defs="columnDefs" :row-data="result.rows"
                     :default-col-def="{ width: 120 }" :enable-cell-text-selection="true" @grid-ready="(e: { api: GridApi }) => (grid = e.api)" />
          <p v-else class="muted empty">Ctrl+Enter 로 커서가 있는 문장을 실행한다. 선택한 부분이 있으면 그것만 실행한다.</p>
        </div>
      </template>
    </SplitPane>
  </div>
</template>

<style scoped>
.sql { height: 100%; display: flex; flex-direction: column; }
.toolbar { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.status { font-size: 12px; color: var(--muted); display: flex; gap: 8px; }
.warn { color: var(--warn); } .ro { color: var(--key); }
.split { flex: 1; min-height: 0; }
.editor { flex: 1; min-height: 0; }
.result { flex: 1; min-height: 0; }
.grid { width: 100%; height: 100%; }
.empty { padding: 12px; }
.muted { color: var(--muted); }
</style>
