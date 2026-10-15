<script setup lang="ts">
// 접속 패널: BE 폴더 → 프로필(dev, test, prod) → 접속 시험, DB 에서 불러오기 → 차이 확인 → 적용
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { ConnTestResult, ProfileInfo, ReverseResult } from '../../../shared/ipc';
import { isEmptyDiff } from '../../../shared/model/merge';

const props = defineProps<{ modelDir: string }>();
const emit = defineEmits<{ apply: [r: ReverseResult]; beDir: [dir: string] }>();

const beDir = ref('');
const profiles = ref<ProfileInfo[]>([]);
const selected = ref('dev');
const test = ref<ConnTestResult | null>(null);
// 모델은 IPC 로 다시 보내므로 Vue 반응형으로 감싸지 않는다 (감싸면 복사 오류)
const pending = shallowRef<ReverseResult | null>(null);
const busy = ref('');
const error = ref('');

onMounted(async () => {
  const s = await window.erd.settings.get();
  if (s.beDir) await setBeDir(s.beDir);
});

async function setBeDir(dir: string) {
  beDir.value = dir;
  profiles.value = await window.erd.conn.list(dir);
  if (!profiles.value.some(p => p.name === selected.value)) selected.value = profiles.value[0]?.name ?? '';
  await window.erd.settings.set({ beDir: dir });
  emit('beDir', dir);
}

async function pickBe() {
  const d = await window.erd.pickFolder(beDir.value || undefined);
  if (d) await setBeDir(d);
}

async function run<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
  busy.value = label; error.value = '';
  try { return await f(); } catch (e) { error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  finally { busy.value = ''; }
}

const doTest = () => run('접속 시험 중', async () => { test.value = await window.erd.conn.test(beDir.value, selected.value); });
const doReverse = () => run('DB 구조 읽는 중', async () => {
  pending.value = await window.erd.db.reverse(beDir.value, selected.value, props.modelDir);
});
function apply() {
  if (pending.value) emit('apply', pending.value);
  pending.value = null;
}

const diffRows = computed(() => {
  const d = pending.value?.diff;
  if (!d) return [];
  return [
    ['추가된 테이블', d.added], ['없어진 테이블', d.removed], ['바뀐 테이블', d.changed],
    ['추가된 함수', d.functionsAdded], ['없어진 함수', d.functionsRemoved], ['바뀐 함수', d.functionsChanged],
  ].filter(([, v]) => (v as string[]).length) as [string, string[]][];
});

defineExpose({ setBeDir, selectProfile: (p: string) => (selected.value = p), doReverse, pending, apply });
</script>

<template>
  <aside class="panel">
    <h3>DB 접속</h3>
    <label>BE 폴더</label>
    <div class="row"><input :value="beDir" readonly placeholder="BE 레포 폴더" /><button @click="pickBe">찾기</button></div>

    <template v-if="beDir">
      <p v-if="!profiles.length" class="warn">application-*.properties 를 찾지 못했다</p>
      <ul class="profiles">
        <li v-for="p in profiles" :key="p.name" :class="{ on: p.name === selected }" @click="selected = p.name; test = null">
          <b>{{ p.name }}</b> <span>{{ p.database }} @ {{ p.host }}:{{ p.port }}</span>
          <em v-if="p.readOnly">읽기 전용</em>
        </li>
      </ul>
      <div class="row">
        <button :disabled="!!busy || !selected" @click="doTest">접속 시험</button>
        <button :disabled="!!busy || !selected || !modelDir" @click="doReverse">DB 에서 불러오기</button>
      </div>
      <p v-if="busy" class="muted">{{ busy }}</p>
      <p v-if="error" class="warn">{{ error }}</p>
      <p v-if="test" :class="test.ok ? 'ok' : 'warn'">
        {{ test.message }}<template v-if="test.ok">: 테이블 {{ test.tables }}, FK {{ test.fks }}</template>
      </p>
    </template>

    <div v-if="pending" class="pending">
      <h4>불러온 결과</h4>
      <p>DB 직접 집계: 테이블 {{ pending.counts.tables }}, FK {{ pending.counts.fks }}</p>
      <p>모델: 테이블 {{ pending.model.tables.length }}, FK {{ pending.model.tables.reduce((n, t) => n + t.fks.length, 0) }}, 함수 {{ pending.model.functions.length }}, 시퀀스 {{ pending.model.sequences.length }}</p>
      <p v-if="!pending.hadModel">모델 폴더에 기존 모델이 없어 새로 만든다</p>
      <p v-else-if="isEmptyDiff(pending.diff)">기존 모델과 같다</p>
      <details v-for="[label, list] in diffRows" :key="label" open>
        <summary>{{ label }} {{ list.length }}개</summary>
        <ul><li v-for="n in list" :key="n">{{ n }}</li></ul>
      </details>
      <details v-if="pending.warnings.length">
        <summary>모델에 담지 않은 것 {{ pending.warnings.length }}개</summary>
        <ul><li v-for="w in pending.warnings" :key="w">{{ w }}</li></ul>
      </details>
      <div class="row"><button @click="apply">화면에 적용</button><button @click="pending = null">취소</button></div>
    </div>
  </aside>
</template>

<style scoped>
.panel { width: 300px; flex: none; padding: 12px; border-right: 1px solid var(--line); overflow: auto; background: var(--panel-bg); }
h3 { margin: 0 0 8px; } h4 { margin: 8px 0 4px; }
label { font-size: 12px; color: var(--muted); }
.row { display: flex; gap: 6px; margin: 6px 0; }
.row input { flex: 1; min-width: 0; }
.profiles { list-style: none; padding: 0; margin: 8px 0; }
.profiles li { padding: 6px; border: 1px solid var(--line); margin-bottom: 4px; cursor: pointer; font-size: 12px; }
.profiles li.on { border-color: var(--accent); background: var(--sel-bg); }
.profiles span { color: var(--muted); }
.profiles em { color: var(--key); font-style: normal; margin-left: 4px; }
.pending { border-top: 1px solid var(--line); margin-top: 8px; font-size: 12px; }
.pending ul { margin: 2px 0; padding-left: 18px; max-height: 160px; overflow: auto; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .muted { color: var(--muted); }
</style>
