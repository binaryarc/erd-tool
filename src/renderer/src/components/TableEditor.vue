<script setup lang="ts">
// 테이블 편집 패널 (STEP 6): 테이블 이름, 코멘트, 컬럼(이름, 타입, NN, PK, 기본값, 코멘트, 순서), FK 를 고친다.
// 모델을 직접 고치지 않고 edit 이벤트로 수정 명령(shared/model/edit.ts)을 보낸다. App 이 되돌리기 기록을 남기고 적용한다.
// 칸은 입력을 마칠 때(Enter, 칸 벗어남) 한 번 적용해 되돌리기 한 번이 칸 하나의 수정이 되게 한다.
import { computed, nextTick, ref, watch } from 'vue';
import { NEW_COLUMN_TYPE, addColumn as addCol, addFk as addFkCmd, defaultFkName, dropColumn, dropFk, dropTable as dropTableCmd, moveColumn, nextColumnName, updateColumn, updateTable, type ColumnInput } from '../../../shared/model/edit';
import type { Column, SchemaModel } from '../../../shared/model/types';

const props = defineProps<{ model: SchemaModel; name: string }>();
const emit = defineEmits<{
  /** 성공하면 true. 실패하면 App 이 오류를 보여준다 */
  edit: [fn: (m: SchemaModel) => SchemaModel, done?: (ok: boolean) => void];
  close: [];
}>();

const t = computed(() => props.model.tables.find(x => x.name === props.name));
const refTables = computed(() => props.model.tables.map(x => x.name).sort());

function apply(fn: (m: SchemaModel) => SchemaModel, done?: (ok: boolean) => void) { emit('edit', fn, done); }

/** 입력 칸 값이 바뀌었을 때만 명령을 보낸다. 실패하면 칸을 원래 값으로 되돌린다 */
function onText(e: Event, old: string, fn: (v: string) => (m: SchemaModel) => SchemaModel) {
  const el = e.target as HTMLInputElement;
  if (el.value === old) return;
  apply(fn(el.value), ok => { if (!ok) el.value = old; });
}

function renameTable(e: Event) {
  const el = e.target as HTMLInputElement;
  const to = el.value.trim();
  if (to === props.name) return;
  apply(m => updateTable(m, props.name, { name: to }), ok => { if (!ok) el.value = props.name; });
}
const setCol = (c: Column, patch: Partial<ColumnInput>) => apply(m => updateColumn(m, props.name, c.name, patch));

function dropTable() {
  if (!confirm(`${props.name} 테이블을 지울까요? 이 테이블을 가리키는 FK 도 함께 지운다 (되돌리기 가능)`)) return;
  apply(m => dropTableCmd(m, props.name), ok => { if (ok) emit('close'); });
}

// ---------- 새 컬럼 ----------
const blank = () => ({ name: '', type: NEW_COLUMN_TYPE, notNull: false, pk: false, default: '', comment: '' });
const draft = ref(blank());
const nameBox = ref<HTMLInputElement>();
function addColumn() {
  const d = draft.value;
  apply(m => addCol(m, props.name, { ...d }), ok => { if (ok) { draft.value = blank(); nameBox.value?.focus(); } });
}

// ---------- Enter 로 컬럼 이어서 추가 (STEP 10) ----------
// column_N 이름, NULL 허용, 기본 타입으로 더하고 그 이름 칸에 포커스. 컬럼 하나가 되돌리기 한 번이다.
const body = ref<HTMLDivElement>();
async function focusColumn(name: string) {
  await nextTick();
  const el = body.value?.querySelector<HTMLInputElement>(`input[data-col="${CSS.escape(name)}"]`);
  el?.focus();
  el?.select();
}
/** after 를 주면 그 컬럼 뒤에, 없으면 공통 컬럼 앞에 */
function addNext(after?: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let name = '';
    apply(m => { name = nextColumnName(m, props.name); return addCol(m, props.name, { name, type: NEW_COLUMN_TYPE, notNull: false }, after); },
      ok => { if (!ok) return resolve(undefined); void focusColumn(name).then(() => resolve(name)); });
  });
}
/** 컬럼 이름 칸에서 Enter: 칸을 벗어나 이름 바꾸기를 적용(change)한 뒤, 그 컬럼 뒤에 다음 컬럼을 더한다 */
function nameEnter(e: KeyboardEvent, c: Column) {
  if (e.isComposing) return; // 한글 조합 중 Enter 는 글자 확정이다
  e.preventDefault();
  const el = e.target as HTMLInputElement;
  // blur 에서 change 가 나 이름 바꾸기가 바로(동기) 적용된다. 실패하면 칸이 원래 이름으로 돌아가므로 칸 글자가 지금 이름이다.
  // props.model 은 다음 그리기 때 바뀌므로 여기서 보지 않는다
  el.blur();
  void addNext(el.value.trim() || c.name);
}

// ---------- 새 FK: 참조 테이블을 고르면 그 PK 컬럼마다 이 테이블 컬럼을 고른다 ----------
const fkRef = ref('');
const fkCols = ref<string[]>([]);
const fkName = ref('');
const refPk = computed(() => props.model.tables.find(x => x.name === fkRef.value)?.pk ?? []);
watch(fkRef, r => {
  // 같은 이름 컬럼이 있으면 미리 골라 둔다
  fkCols.value = refPk.value.map(p => (t.value?.columns.some(c => c.name === p) ? p : ''));
  fkName.value = r ? defaultFkName(props.model, props.name, r) : '';
});
watch(() => props.name, () => { fkRef.value = ''; draft.value = blank(); });
function addFk() {
  const fk = { name: fkName.value.trim(), columns: [...fkCols.value], refTable: fkRef.value, refColumns: [...refPk.value] };
  apply(m => addFkCmd(m, props.name, fk), ok => { if (ok) fkRef.value = ''; });
}

defineExpose({
  /** 시험용: 화면 칸과 같은 경로로 컬럼, FK 를 더한다 */
  addColumnDraft: (d: Partial<ReturnType<typeof blank>>) => { draft.value = { ...blank(), ...d }; addColumn(); },
  addFkDraft: (refTable: string, cols: string[]) => { fkRef.value = refTable; fkCols.value = cols; fkName.value = defaultFkName(props.model, props.name, refTable); addFk(); },
  addNext,
});
</script>

<template>
  <section v-if="t" class="editor">
    <header>
      <b>테이블 편집</b>
      <span class="spacer" />
      <button class="danger" @click="dropTable">테이블 삭제</button>
      <button title="닫기" @click="emit('close')">×</button>
    </header>
    <div ref="body" class="ed-body">
      <div class="grid2">
        <label>물리명</label><input :value="t.name" spellcheck="false" @change="renameTable" @keydown.enter="($event.target as HTMLInputElement).blur()" />
        <label>논리명</label><input :value="t.comment" @change="e => onText(e, t!.comment, v => m => updateTable(m, props.name, { comment: v }))" @keydown.enter="($event.target as HTMLInputElement).blur()" />
      </div>

      <h4>컬럼 {{ t.columns.length }}개</h4>
      <table class="cols">
        <thead><tr><th>No.</th><th>이름</th><th>타입</th><th title="NOT NULL">NN</th><th>PK</th><th>기본값</th><th>코멘트</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(c, i) in t.columns" :key="c.name">
            <td class="no">{{ i + 1 }}</td>
            <td><input :value="c.name" :data-col="c.name" :data-orig="c.name" spellcheck="false" title="Enter 를 치면 이 컬럼 뒤에 새 컬럼을 더한다"
                       @change="e => onText(e, c.name, v => m => updateColumn(m, props.name, c.name, { name: v.trim() }))" @keydown.enter="e => nameEnter(e, c)" /></td>
            <td><input :value="c.type" spellcheck="false" class="type" @change="e => onText(e, c.type, v => m => updateColumn(m, props.name, c.name, { type: v }))" /></td>
            <td><input type="checkbox" :checked="c.notNull" :disabled="t.pk.includes(c.name)" :title="t.pk.includes(c.name) ? 'PK 는 NOT NULL 이다' : ''"
                       @change="e => setCol(c, { notNull: (e.target as HTMLInputElement).checked })" /></td>
            <td><input type="checkbox" :checked="t.pk.includes(c.name)" @change="e => setCol(c, { pk: (e.target as HTMLInputElement).checked })" /></td>
            <td><input :value="c.default ?? ''" spellcheck="false" @change="e => onText(e, c.default ?? '', v => m => updateColumn(m, props.name, c.name, { default: v }))" /></td>
            <td><input :value="c.comment ?? ''" @change="e => onText(e, c.comment ?? '', v => m => updateColumn(m, props.name, c.name, { comment: v }))" /></td>
            <td class="act">
              <button title="위로" :disabled="i === 0" @click="apply(m => moveColumn(m, props.name, c.name, -1))">↑</button>
              <button title="아래로" :disabled="i === t.columns.length - 1" @click="apply(m => moveColumn(m, props.name, c.name, 1))">↓</button>
              <button title="컬럼 삭제 (이 컬럼이 든 키도 지운다)" class="danger" @click="apply(m => dropColumn(m, props.name, c.name))">×</button>
            </td>
          </tr>
          <tr class="new" @keydown.enter="addColumn">
            <td class="no">+</td>
            <td><input ref="nameBox" v-model="draft.name" placeholder="새 컬럼" spellcheck="false" /></td>
            <td><input v-model="draft.type" spellcheck="false" class="type" /></td>
            <td><input v-model="draft.notNull" type="checkbox" :disabled="draft.pk" /></td>
            <td><input v-model="draft.pk" type="checkbox" /></td>
            <td><input v-model="draft.default" spellcheck="false" /></td>
            <td><input v-model="draft.comment" /></td>
            <td class="act"><button :disabled="!draft.name.trim()" @click="addColumn">추가</button></td>
          </tr>
        </tbody>
      </table>
      <p class="muted">새 컬럼은 공통 컬럼(reg_id 등) 앞에 들어간다. Enter 로 추가. 컬럼 이름 칸에서 Enter 를 치면 그 뒤에 column_N 이 이어서 생긴다.</p>

      <h4>FK {{ t.fks.length }}개</h4>
      <table v-if="t.fks.length" class="fks">
        <thead><tr><th>No.</th><th>이름</th><th>컬럼</th><th>참조</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(f, i) in t.fks" :key="f.name">
            <td class="no">{{ i + 1 }}</td><td>{{ f.name }}</td><td>{{ f.columns.join(', ') }}</td><td>{{ f.refTable }}({{ f.refColumns.join(', ') }})</td>
            <td class="act"><button class="danger" title="FK 삭제" @click="apply(m => dropFk(m, props.name, f.name))">×</button></td>
          </tr>
        </tbody>
      </table>
      <div class="fk-new">
        <label>참조 테이블
          <select v-model="fkRef">
            <option value="">고르세요</option>
            <option v-for="n in refTables" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <template v-if="fkRef">
          <p v-if="!refPk.length" class="warn">{{ fkRef }} 에 PK 가 없어 FK 로 가리킬 수 없다</p>
          <template v-else>
            <label v-for="(p, i) in refPk" :key="p">{{ fkRef }}.{{ p }} ←
              <select v-model="fkCols[i]">
                <option value="">이 테이블 컬럼</option>
                <option v-for="c in t.columns" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
              </select>
            </label>
            <label>이름 <input v-model="fkName" spellcheck="false" /></label>
            <button :disabled="fkCols.some(c => !c) || !fkName.trim()" @click="addFk">FK 추가</button>
          </template>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.editor { height: 100%; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--bg); font-size: 12px; }
header { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.spacer { flex: 1; }
.ed-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px; }
.grid2 { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; align-items: center; }
h4 { margin: 12px 0 4px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--line); padding: 1px 3px; text-align: left; white-space: nowrap; }
td input:not([type=checkbox]) { width: 100%; min-width: 60px; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--fg); font: 12px Consolas, 'Malgun Gothic', monospace; padding: 1px 2px; }
td input:not([type=checkbox]):focus { border-color: var(--accent); background: var(--bg); outline: none; }
input, select { color: var(--fg); background: var(--bg); border: 1px solid var(--line); }
.no { color: var(--muted); text-align: right; width: 24px; }
.act { width: 1%; }
.act button { padding: 0 4px; }
.new td { background: var(--panel-bg); }
.fk-new { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; align-items: flex-start; }
.danger { color: var(--warn); }
.warn { color: var(--warn); } .muted { color: var(--muted); margin: 2px 0; }
</style>
