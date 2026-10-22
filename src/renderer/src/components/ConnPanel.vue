<script setup lang="ts">
// 접속 패널: 접속 정보 가져오는 방법(BE 폴더 자동 매핑, 직접 입력)을 고르고 → 접속 시험, DB 에서 불러오기 → 차이 확인 → 적용
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { ConnRef, ConnSource, ConnTestResult, ManualConnInfo, ProfileInfo, ReverseResult } from '../../../shared/ipc';
import { applySelected, isEmptyDiff } from '../../../shared/model/merge';
import { groupsFromPrefixes } from '../../../shared/model/groups';
import ManualConnForm from './ManualConnForm.vue';

/** canReplace: 지금 ERD 를 바꿔도 되는지 (저장 안 한 변경이 있으면 화면이 묻는다). false 면 불러온 결과를 그대로 둔다 */
const props = defineProps<{ modelDir: string; canReplace?: () => boolean }>();
const emit = defineEmits<{ apply: [r: ReverseResult]; beDir: [dir: string] }>();

const source = ref<ConnSource>('be');
const beDir = ref('');
const profiles = ref<ProfileInfo[]>([]);
const manuals = ref<ManualConnInfo[]>([]);
/** BE 프로필 이름 또는 직접 입력 접속 id */
const selected = ref('');
/** 편집 중인 직접 입력 접속 (null: 닫힘, 'new': 새로 추가) */
const editing = ref<ManualConnInfo | 'new' | null>(null);
const test = ref<ConnTestResult | null>(null);
// 모델은 IPC 로 다시 보내므로 Vue 반응형으로 감싸지 않는다 (감싸면 복사 오류)
const pending = shallowRef<ReverseResult | null>(null);
const busy = ref('');
const error = ref('');

onMounted(async () => {
  const s = await window.erd.settings.get();
  groupFile.value = s.groupRulesFile ?? '';
  prefixText.value = (s.groupPrefixes ?? []).join(', ');
  manuals.value = await window.erd.manual.list();
  if (s.connSource) source.value = s.connSource;
  if (s.beDir) await setBeDir(s.beDir);
  if (source.value === 'manual' && manuals.value[0]) selected.value = manuals.value[0].id;
});

/** 기본으로 고를 프로필: 쓰기 허용 목록(설정 writableProfiles)에 든 첫 프로필, 없으면 첫 프로필 */
const defaultProfile = () => (profiles.value.find(p => !p.readOnly) ?? profiles.value[0])?.name ?? '';

async function setSource(s: ConnSource) {
  source.value = s; test.value = null; error.value = '';
  selected.value = s === 'be' ? defaultProfile() : manuals.value[0]?.id ?? '';
  await window.erd.settings.set({ connSource: s });
}

async function setBeDir(dir: string) {
  beDir.value = dir;
  profiles.value = await window.erd.conn.list(dir);
  if (source.value === 'be' && !profiles.value.some(p => p.name === selected.value)) selected.value = defaultProfile();
  await window.erd.settings.set({ beDir: dir });
  emit('beDir', dir);
}

async function pickBe() {
  const d = await window.erd.pickFolder(beDir.value || undefined);
  if (d) await setBeDir(d);
}

async function onSaved(c: ManualConnInfo) {
  manuals.value = await window.erd.manual.list();
  selected.value = c.id;
  editing.value = null;
}

async function removeManual(c: ManualConnInfo) {
  if (!confirm(`「${c.name}」 접속을 지울까요?`)) return;
  await window.erd.manual.remove(c.id);
  manuals.value = await window.erd.manual.list();
  if (selected.value === c.id) selected.value = manuals.value[0]?.id ?? '';
}

// ---------- 그룹 규칙 (모델이 처음 생길 때만 쓴다, 2026-10-22) ----------
// 규칙 파일(erd-groups.json 형식)이나 접두어 목록 중 하나. 하나를 정하면 다른 하나는 지운다
const groupFile = ref('');
const prefixText = ref('');
const groupMsg = ref('');

async function pickGroupFile() {
  const f = await window.erd.pickFile(groupFile.value || props.modelDir || undefined, 'json');
  if (!f) return;
  await window.erd.settings.set({ groupRulesFile: f, groupPrefixes: undefined });
  groupFile.value = f; prefixText.value = ''; groupMsg.value = '';
}
async function savePrefixes() {
  const list = prefixText.value.split(/[,\s]+/).filter(Boolean);
  try {
    const groups = list.length ? groupsFromPrefixes(list) : [];
    await window.erd.settings.set({ groupPrefixes: list.length ? list : undefined, groupRulesFile: undefined });
    groupFile.value = '';
    groupMsg.value = list.length ? `그룹 ${groups.map(g => g.name).join(', ')}` : '접두어를 비웠습니다';
  } catch (e) { groupMsg.value = (e as Error).message; }
}
async function clearGroupFile() {
  await window.erd.settings.set({ groupRulesFile: undefined });
  groupFile.value = ''; groupMsg.value = '';
}

const ref_ = (): ConnRef => (source.value === 'be' ? { source: 'be', beDir: beDir.value, name: selected.value } : { source: 'manual', id: selected.value });
const ready = computed(() => !!selected.value && (source.value === 'manual' || !!beDir.value));

async function run<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
  busy.value = label; error.value = '';
  try { return await f(); } catch (e) { error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  finally { busy.value = ''; }
}

/** 비밀번호를 입력해 저장했는지 표시를 다시 읽는다 */
async function refreshProfiles() { if (beDir.value) profiles.value = await window.erd.conn.list(beDir.value); }
async function forgetPw(name: string) {
  await window.erd.conn.forgetPassword(beDir.value, name);
  await refreshProfiles();
}

const doTest = () => run('접속 시험 중', async () => { test.value = await window.erd.conn.test(ref_()); await refreshProfiles(); });
const doReverse = () => run('DB 구조 읽는 중', async () => {
  pending.value = await window.erd.db.reverse(ref_(), props.modelDir);
  await refreshProfiles();
  const d = pending.value.diff;
  picked.value = new Set([...d.added, ...d.removed, ...d.changed]); // 기본은 모두 받기
  takeRoutines.value = true;
});

// DB → ERD 골라 받기: 고른 테이블만 DB 것으로, 나머지는 지금 모델 그대로 (설계 6-1)
const picked = ref(new Set<string>());
const takeRoutines = ref(true);
const changedNames = computed(() => {
  const d = pending.value?.diff;
  return d ? [...d.added, ...d.removed, ...d.changed] : [];
});
function toggle(name: string) {
  const s = new Set(picked.value);
  if (s.has(name)) s.delete(name); else s.add(name);
  picked.value = s;
}
const pickAll = (on: boolean) => { picked.value = new Set(on ? changedNames.value : []); };

function apply() {
  const r = pending.value;
  if (!r) return;
  if (props.canReplace && !props.canReplace()) return;
  const model = r.hadModel ? applySelected(r.prev, r.model, picked.value, takeRoutines.value) : r.model;
  emit('apply', { ...r, model });
  pending.value = null;
}

const tableRows = computed(() => {
  const d = pending.value?.diff;
  if (!d) return [];
  return ([['추가된 테이블', d.added], ['없어진 테이블', d.removed], ['바뀐 테이블', d.changed]] as [string, string[]][])
    .filter(([, v]) => v.length);
});
const routineCount = computed(() => {
  const d = pending.value?.diff;
  return d ? d.functionsAdded.length + d.functionsRemoved.length + d.functionsChanged.length + (d.sequencesChanged ? 1 : 0) : 0;
});

defineExpose({ setSource, setBeDir, select: (v: string) => (selected.value = v), doReverse, pending, apply, picked, toggle });
</script>

<template>
  <aside class="panel">
    <h3>DB 접속</h3>
    <div class="tabs">
      <button :class="{ on: source === 'be' }" @click="setSource('be')">BE 폴더에서</button>
      <button :class="{ on: source === 'manual' }" @click="setSource('manual')">직접 입력</button>
    </div>

    <template v-if="source === 'be'">
      <label>BE 폴더 (application-*.properties, .yml 을 읽습니다)</label>
      <div class="row"><input :value="beDir" readonly placeholder="BE 레포 폴더" /><button @click="pickBe">찾기</button></div>
      <p v-if="beDir && !profiles.length" class="warn">application-*.properties, .yml 을 찾지 못했습니다</p>
      <ul class="profiles">
        <li v-for="p in profiles" :key="p.name" :class="{ on: p.name === selected }" @click="selected = p.name; test = null">
          <b>{{ p.name }}</b> <span>{{ p.database }} @ {{ p.host }}:{{ p.port }}</span>
          <em v-if="p.readOnly">읽기 전용</em>
          <span v-if="p.savedPassword" class="saved">입력한 비밀번호 저장됨
            <a href="#" title="지우면 다음 접속부터 BE 폴더 설정에서 다시 자동으로 읽습니다" @click.stop.prevent="forgetPw(p.name)">지우기</a></span>
        </li>
      </ul>
    </template>

    <template v-else>
      <ul class="profiles">
        <li v-for="c in manuals" :key="c.id" :class="{ on: c.id === selected }" @click="selected = c.id; test = null">
          <b>{{ c.name }}</b> <span>{{ c.database }} @ {{ c.host }}:{{ c.port }}</span>
          <em v-if="c.readOnly">읽기 전용</em>
          <em v-if="!c.hasPassword" class="warn">비밀번호 필요</em>
          <span class="acts">
            <a @click.stop="editing = c">편집</a>
            <a @click.stop="removeManual(c)">삭제</a>
          </span>
        </li>
      </ul>
      <p v-if="!manuals.length && !editing" class="muted">저장한 접속이 없습니다</p>
      <ManualConnForm v-if="editing" :key="editing === 'new' ? 'new' : editing.id" :conn="editing === 'new' ? undefined : editing"
                      @saved="onSaved" @cancel="editing = null" />
      <button v-else @click="editing = 'new'">+ 접속 추가</button>
    </template>

    <div class="row">
      <button :disabled="!!busy || !ready" @click="doTest">접속 시험</button>
      <button :disabled="!!busy || !ready || !modelDir" @click="doReverse">DB 에서 불러오기</button>
    </div>
    <p v-if="!modelDir" class="muted">불러오려면 먼저 위에서 모델 폴더를 정하세요.</p>
    <details class="groups">
      <summary>그룹 규칙 <span class="muted">({{ groupFile ? '파일' : prefixText ? '접두어' : '모델 폴더의 erd-groups.json, 없으면 그룹 하나' }})</span></summary>
      <p class="muted">모델을 처음 만들 때만 씁니다. 이미 있는 모델은 그 모델의 그룹을 그대로 씁니다.</p>
      <label>규칙 파일 (erd-groups.json 형식)</label>
      <div class="row"><input :value="groupFile" readonly placeholder="고르지 않음" /><button @click="pickGroupFile">찾기</button><button v-if="groupFile" @click="clearGroupFile">지우기</button></div>
      <label>또는 테이블 이름 접두어 (쉼표로 구분)</label>
      <div class="row"><input v-model="prefixText" spellcheck="false" placeholder="mst_, whs_" /><button @click="savePrefixes">저장</button></div>
      <p v-if="groupMsg" class="muted">{{ groupMsg }}</p>
    </details>
    <p v-if="busy" class="muted">{{ busy }}</p>
    <p v-if="error" class="warn">{{ error }}</p>
    <p v-if="test" :class="test.ok ? 'ok' : 'warn'">
      {{ test.message }}<template v-if="test.ok">: 테이블 {{ test.tables }}, FK {{ test.fks }}</template>
    </p>

    <div v-if="pending" class="pending">
      <h4>불러온 결과</h4>
      <p>DB 직접 집계: 테이블 {{ pending.counts.tables }}, FK {{ pending.counts.fks }}</p>
      <p>모델: 테이블 {{ pending.model.tables.length }}, FK {{ pending.model.tables.reduce((n, t) => n + t.fks.length, 0) }}, 함수 {{ pending.model.functions.length }}, 시퀀스 {{ pending.model.sequences.length }}</p>
      <p v-if="!pending.hadModel">모델 폴더에 기존 모델이 없어 새로 만듭니다</p>
      <p v-else-if="isEmptyDiff(pending.diff)">기존 모델과 같습니다</p>
      <template v-if="pending.hadModel && changedNames.length">
        <p class="muted">받을 테이블을 고르세요. 고르지 않은 테이블은 지금 모델 그대로 둡니다.
          <a @click="pickAll(true)">모두 고르기</a> <a @click="pickAll(false)">모두 풀기</a></p>
        <details v-for="[label, list] in tableRows" :key="label" open>
          <summary>{{ label }} {{ list.length }}개</summary>
          <ul class="picks"><li v-for="n in list" :key="n"><label><input type="checkbox" :checked="picked.has(n)" @change="toggle(n)" /> {{ n }}</label></li></ul>
        </details>
      </template>
      <label v-if="pending.hadModel && routineCount" class="check"><input v-model="takeRoutines" type="checkbox" /> 함수, 시퀀스 변화도 받기 ({{ routineCount }}개)</label>
      <details v-if="pending.warnings.length">
        <summary>모델에 담지 않은 것 {{ pending.warnings.length }}개</summary>
        <ul><li v-for="w in pending.warnings" :key="w">{{ w }}</li></ul>
      </details>
      <div class="row"><button @click="apply">{{ pending.hadModel && changedNames.length ? `고른 것 적용 (${picked.size}개)` : '화면에 적용' }}</button><button @click="pending = null">취소</button></div>
    </div>
  </aside>
</template>

<style scoped>
.panel { width: 100%; height: 100%; box-sizing: border-box; padding: 12px; border-right: 1px solid var(--line); overflow: auto; background: var(--panel-bg); }
h3 { margin: 0 0 8px; } h4 { margin: 8px 0 4px; }
label { font-size: 12px; color: var(--muted); }
.tabs { display: flex; margin-bottom: 8px; }
.tabs button { flex: 1; border: 1px solid var(--line); background: var(--bg); color: var(--fg); padding: 4px; cursor: pointer; }
.tabs button.on { border-color: var(--accent); background: var(--sel-bg); font-weight: bold; }
.row { display: flex; gap: 6px; margin: 6px 0; }
.row input { flex: 1; min-width: 0; }
.profiles { list-style: none; padding: 0; margin: 8px 0; }
.profiles li { padding: 6px; border: 1px solid var(--line); margin-bottom: 4px; cursor: pointer; font-size: 12px; }
.profiles li.on { border-color: var(--accent); background: var(--sel-bg); }
.profiles span { color: var(--muted); }
.profiles em { color: var(--key); font-style: normal; margin-left: 4px; }
.profiles .saved { display: block; margin-top: 2px; }
.acts { float: right; } .acts a { margin-left: 6px; color: var(--accent); cursor: pointer; }
.pending { border-top: 1px solid var(--line); margin-top: 8px; font-size: 12px; }
.pending ul { margin: 2px 0; padding-left: 18px; max-height: 160px; overflow: auto; }
.pending .picks { list-style: none; padding-left: 4px; }
.pending a { color: var(--accent); cursor: pointer; margin-left: 6px; }
.check { display: block; margin: 4px 0; color: var(--fg); }
.groups { font-size: 12px; margin: 6px 0; } .groups p { margin: 4px 0; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .muted { color: var(--muted); }
</style>
