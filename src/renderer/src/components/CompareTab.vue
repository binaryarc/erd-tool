<script setup lang="ts">
// DB 비교 (설계 6-2): 왼쪽(지금 모습)과 오른쪽(바꿀 모습)을 접속, 모델 폴더, 지금 ERD 중에서 골라 차이를 보고,
// 왼쪽을 오른쪽처럼 바꾸는 ALTER 를 만들거나 왼쪽 DB 에 적용한다(새 SQL 탭에 넣을 뿐, 바로 실행하지 않는다).
// 바로 적용은 dev 기준이다. test, 운영은 「Flyway 파일로」 로 만든 파일로 반영한다(STEP 7). 파일만 만들고 DB 에 실행하지 않는다.
import { computed, onMounted, ref, shallowRef } from 'vue';
import { DIFF_CHANGE_LABEL, DIFF_KIND_LABEL, diffModels, summarize, type DiffItem, type DiffKind } from '../../../shared/model/diff';
import { buildAlter } from '../../../shared/sql/alter';
import { dialectOf } from '../../../shared/dialect/names';
import { buildFlyway, suggestDescription, validDescription } from '../../../shared/export/flyway';
import type { SchemaModel } from '../../../shared/model/types';
import { loadConnOptions, type ConnOption } from '../conn-options';

const props = defineProps<{ model: SchemaModel | null }>();
const emit = defineEmits<{ openSql: [p: { sql: string; conn?: string }] }>();

interface Side { kind: 'conn' | 'folder' | 'erd'; key: string; dir: string }
const options = shallowRef<ConnOption[]>([]);
const left = ref<Side>({ kind: 'conn', key: '', dir: '' });
const right = ref<Side>({ kind: 'conn', key: '', dir: '' });
const items = shallowRef<DiffItem[]>([]);
const alterSql = ref('');
const busy = ref('');
const error = ref('');
const done = ref(false);
const filterKind = ref<DiffKind | ''>('');
const dangerOnly = ref(false);
/** 마지막으로 비교한 두 쪽 모델 (Flyway 파일을 만들 때 쓴다) */
let lastFrom: SchemaModel | null = null;
let lastTo: SchemaModel | null = null;
/** Flyway 파일은 PostgreSQL 만 (STEP 9 범위). 다른 DB 비교면 버튼을 끈다 */
const flywayOk = ref(true);

const KIND_LABEL = DIFF_KIND_LABEL;
const CHANGE_LABEL = DIFF_CHANGE_LABEL;

/** 접속 목록을 다 읽었을 때 풀린다 (탭을 열자마자 비교하는 「DB 에 적용」 버튼이 기다린다) */
const ready = new Promise<void>(done => onMounted(async () => {
  options.value = await loadConnOptions();
  left.value.key = options.value.find(o => o.key === 'be:dev')?.key ?? options.value[0]?.key ?? '';
  right.value.key = options.value.find(o => o.key === 'be:test')?.key ?? options.value[1]?.key ?? '';
  done();
}));

const sideValue = (s: Side) => (s.kind === 'conn' ? 'conn:' + s.key : s.kind);
async function setSide(which: 'left' | 'right', v: string) {
  const side = which === 'left' ? left : right;
  if (v.startsWith('conn:')) side.value = { kind: 'conn', key: v.slice(5), dir: '' };
  else if (v === 'erd') side.value = { kind: 'erd', key: '', dir: '' };
  else {
    const d = await window.erd.pickFolder(side.value.dir || undefined);
    if (d) side.value = { kind: 'folder', key: '', dir: d };
  }
}
const sideLabel = (s: Side) => s.kind === 'conn' ? options.value.find(o => o.key === s.key)?.label ?? '접속 없음' : s.kind === 'erd' ? '지금 ERD' : s.dir;

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function read(s: Side): Promise<SchemaModel> {
  if (s.kind === 'erd') {
    if (!props.model) throw new Error('ERD 에 열린 모델이 없습니다');
    return props.model;
  }
  if (s.kind === 'folder') return (await window.erd.model.load(s.dir)).model;
  const o = options.value.find(x => x.key === s.key);
  if (!o) throw new Error('접속을 고르세요');
  return (await window.erd.db.read(o.ref)).model;
}

async function compare() {
  busy.value = '두 쪽 구조를 읽는 중'; error.value = ''; done.value = false;
  try {
    const [a, b] = await Promise.all([read(left.value), read(right.value)]);
    items.value = diffModels(a, b);
    alterSql.value = buildAlter(a, b, items.value).sql;
    lastFrom = a; lastTo = b;
    flywayOk.value = dialectOf(a.dialect ? a : b) === 'postgresql';
    fw.value.description = suggestDescription(items.value);
    fw.value.result = '';
    done.value = true;
  } catch (e) { error.value = clean(e); }
  finally { busy.value = ''; }
  return { items: items.value.length, dangers: items.value.filter(i => i.danger).length };
}

function swap() {
  [left.value, right.value] = [right.value, left.value];
  done.value = false; items.value = [];
}

const summary = computed(() => summarize(items.value));
const shown = computed(() => items.value.filter(i => (!filterKind.value || i.kind === filterKind.value) && (!dangerOnly.value || i.danger)));

const leftConn = computed(() => (left.value.kind === 'conn' ? options.value.find(o => o.key === left.value.key) : undefined));
const canApply = computed(() => done.value && items.value.length > 0 && !!leftConn.value && !leftConn.value.readOnly);

function makeAlter() { emit('openSql', { sql: alterSql.value }); }

function apply() {
  const c = leftConn.value;
  if (!c || c.readOnly) return;
  if (c.profile !== 'dev' && !confirm(`${c.label} 은(는) dev 가 아닙니다. test, 운영은 Flyway 가 꺼져 있어 도구에서 바로 바꾸면 Flyway 이력에 남지 않습니다.\nFlyway 파일로 반영하기를 권합니다. 그래도 이 접속의 SQL 탭에 ALTER 를 넣을까요?`)) return;
  emit('openSql', { sql: alterSql.value, conn: c.key });
}

// ---------- Flyway 파일로 (STEP 7) ----------
// 폴더는 내보낼 때마다 고르고 마지막 위치를 기억한다. 처음 기본값은 BE 의 db/migration
const fw = ref({ description: '', menuCode: '', history: false, result: '', error: '' });

async function defaults() {
  const s = await window.erd.settings.get();
  const be = s.beDir?.replace(/[\\/]+$/, '');
  const project = be ? be.split(/[\\/]/).pop()!.replace(/-be$/, '') : '';
  return {
    settings: s,
    flyway: s.exportDirs?.flyway ?? (be ? `${be}/src/main/resource/db/migration` : undefined),
    history: s.exportDirs?.history ?? (be ? `${be}/../docs-hub/spec/${project}/_knowledge/patterns/20-database/40-schema/99-migration-history.md` : undefined),
  };
}

/** 고른 폴더(와 이력 파일)로 파일을 만든다. 화면 버튼과 시험이 같이 쓴다 */
async function writeFlyway(dir: string, historyFile?: string) {
  fw.value.error = ''; fw.value.result = '';
  try {
    if (!lastFrom || !lastTo) throw new Error('먼저 비교하세요');
    const version = await window.erd.export.nextVersion(dir);
    const f = buildFlyway({ from: lastFrom, to: lastTo, version, description: fw.value.description.trim(), menuCode: fw.value.menuCode.trim() || undefined,
      fromLabel: sideLabel(left.value), toLabel: sideLabel(right.value), now: new Date() });
    const r = await window.erd.export.write(dir, [{ name: f.fileName, content: f.sql }], historyFile ? { file: historyFile, line: f.historyLine } : undefined);
    fw.value.result = `만들었습니다: ${r.written[0]} (문장 ${f.statements}개, 위험 ${f.dangers}개)${r.history ? `, 이력 한 줄 추가: ${r.history}` : ''}. DB 에는 실행하지 않았습니다`;
    return { fileName: f.fileName, path: r.written[0], history: r.history, statements: f.statements, sql: f.sql };
  } catch (e) { fw.value.error = clean(e); return null; }
}

async function makeFlyway() {
  if (!validDescription(fw.value.description.trim())) { fw.value.error = '설명은 영문 소문자 snake_case 로 적어 주세요 (예: add_mst_biz_columns)'; return; }
  const d = await defaults();
  const dir = await window.erd.pickFolder(d.flyway);
  if (!dir) return;
  let historyFile: string | undefined;
  if (fw.value.history) {
    historyFile = (await window.erd.pickFile(d.history)) ?? undefined;
    if (!historyFile) return;
  }
  await window.erd.settings.set({ exportDirs: { ...d.settings.exportDirs, flyway: dir, ...(historyFile ? { history: historyFile } : {}) } });
  await writeFlyway(dir, historyFile);
}

defineExpose({ ready, compare, writeFlyway, setFlyway: (p: Partial<typeof fw.value>) => Object.assign(fw.value, p), setLeft: (k: string) => (left.value = { kind: 'conn', key: k, dir: '' }), setRight: (k: string) => (right.value = { kind: 'conn', key: k, dir: '' }),
  setRightErd: () => (right.value = { kind: 'erd', key: '', dir: '' }), items: () => items.value, alter: () => alterSql.value, apply });
</script>

<template>
  <section class="compare">
    <div class="pick">
      <div class="side">
        <b>왼쪽 (지금 모습)</b>
        <select :value="sideValue(left)" @change="e => setSide('left', (e.target as HTMLSelectElement).value)">
          <option v-for="o in options" :key="o.key" :value="'conn:' + o.key">{{ o.label }}{{ o.readOnly ? ' [읽기 전용]' : '' }}</option>
          <option value="erd">지금 ERD</option>
          <option value="folder">모델 폴더 고르기…</option>
        </select>
        <span class="muted">{{ left.kind === 'folder' ? left.dir : '' }}</span>
      </div>
      <button title="왼쪽과 오른쪽 바꾸기" @click="swap">⇄</button>
      <div class="side">
        <b>오른쪽 (바꿀 모습)</b>
        <select :value="sideValue(right)" @change="e => setSide('right', (e.target as HTMLSelectElement).value)">
          <option v-for="o in options" :key="o.key" :value="'conn:' + o.key">{{ o.label }}{{ o.readOnly ? ' [읽기 전용]' : '' }}</option>
          <option value="erd">지금 ERD</option>
          <option value="folder">모델 폴더 고르기…</option>
        </select>
        <span class="muted">{{ right.kind === 'folder' ? right.dir : '' }}</span>
      </div>
      <button :disabled="!!busy" @click="compare">비교</button>
    </div>
    <p v-if="busy" class="muted">{{ busy }}</p>
    <p v-if="error" class="warn">{{ error }}</p>

    <template v-if="done">
      <p v-if="!items.length" class="ok">두 쪽이 같습니다 ({{ sideLabel(left) }} = {{ sideLabel(right) }})</p>
      <template v-else>
        <div class="actions">
          <span>{{ sideLabel(left) }} 을(를) {{ sideLabel(right) }} 처럼 바꾸려면 차이 {{ items.length }}개 (위험 {{ items.filter(i => i.danger).length }}개)</span>
          <span class="spacer" />
          <button @click="makeAlter">ALTER 만들기</button>
          <button :disabled="!canApply" :title="leftConn?.readOnly ? '읽기 전용 접속에는 적용할 수 없습니다' : !leftConn ? '왼쪽이 DB 접속일 때만 적용할 수 있습니다' : ''" @click="apply">왼쪽 DB 에 적용</button>
        </div>
        <div class="flyway">
          <b>Flyway 파일로</b>
          <label>설명 <input v-model="fw.description" spellcheck="false" placeholder="add_mst_biz_columns" /></label>
          <label>메뉴코드 <input v-model="fw.menuCode" spellcheck="false" placeholder="없으면 비움" class="short" /></label>
          <label class="check"><input v-model="fw.history" type="checkbox" /> 99-migration-history.md 에 한 줄 추가</label>
          <button :disabled="!flywayOk" :title="flywayOk ? '폴더를 고르면 V{다음 번호}__{설명}_{시각}.sql 을 만듭니다. DB 에는 실행하지 않습니다' : 'Flyway 파일은 PostgreSQL 모델에서만 만들 수 있습니다'" @click="makeFlyway">Flyway 파일 만들기</button>
        </div>
        <p v-if="fw.result" class="ok">{{ fw.result }}</p>
        <p v-if="fw.error" class="warn">{{ fw.error }}</p>
        <table class="sum">
          <thead><tr><th>No.</th><th>종류</th><th>추가</th><th>삭제</th><th>변경</th><th>이름 바꿈</th></tr></thead>
          <tbody>
            <tr v-for="([k, v], i) in Object.entries(summary).filter(([, v]) => v.add + v.drop + v.alter + v.rename)" :key="k"
                :class="{ on: filterKind === k }" @click="filterKind = filterKind === k ? '' : (k as DiffKind)">
              <td>{{ i + 1 }}</td><td>{{ KIND_LABEL[k as DiffKind] }}</td><td>{{ v.add }}</td><td>{{ v.drop }}</td><td>{{ v.alter }}</td><td>{{ v.rename }}</td>
            </tr>
          </tbody>
        </table>
        <label class="check"><input v-model="dangerOnly" type="checkbox" /> 위험만 보기</label>
        <span v-if="filterKind" class="muted">{{ KIND_LABEL[filterKind] }} 만 보는 중 (표의 줄을 다시 누르면 풀립니다)</span>
        <div class="list">
          <table>
            <thead><tr><th>No.</th><th>종류</th><th>변화</th><th>테이블</th><th>대상</th><th>내용</th><th>위험</th></tr></thead>
            <tbody>
              <tr v-for="(d, i) in shown" :key="i" :class="d.change">
                <td>{{ i + 1 }}</td><td>{{ KIND_LABEL[d.kind] }}</td><td>{{ CHANGE_LABEL[d.change] }}</td>
                <td>{{ d.table ?? '' }}</td><td>{{ d.name }}</td><td>{{ d.detail }}</td><td class="warn">{{ d.danger ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.compare { height: 100%; display: flex; flex-direction: column; padding: 8px 12px; box-sizing: border-box; font-size: 12px; overflow: hidden; }
.pick { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.side { display: flex; flex-direction: column; gap: 2px; }
.actions { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
.spacer { flex: 1; }
table { border-collapse: collapse; width: auto; }
th, td { border: 1px solid var(--line); padding: 2px 6px; text-align: left; white-space: nowrap; }
.sum tr { cursor: pointer; } .sum tr.on { background: var(--sel-bg); }
.list { flex: 1; min-height: 0; overflow: auto; margin-top: 6px; }
.list td:nth-child(6) { white-space: normal; }
tr.add td:nth-child(3) { color: var(--ok); } tr.drop td:nth-child(3) { color: var(--warn); }
.check { margin-right: 10px; }
.flyway { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 8px; border: 1px dashed var(--line); }
.flyway input:not([type=checkbox]) { width: 220px; } .flyway input.short { width: 90px; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .muted { color: var(--muted); }
</style>
