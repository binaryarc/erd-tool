<script setup lang="ts">
// STEP 2 화면: 모델 폴더를 열고 그룹별 테이블 수, 검증 오류를 보여준다. ERD 캔버스는 STEP 3.
import { computed, ref, shallowRef, toRaw } from 'vue';
import { groupOf } from '../../shared/model/erd-format';
import type { LoadResult } from '../../shared/ipc';

const dir = ref('');
const loaded = shallowRef<LoadResult | null>(null);
const message = ref('');

const groups = computed(() => {
  const m = loaded.value?.model;
  if (!m) return [];
  const count = new Map<string, number>();
  for (const t of m.tables) count.set(groupOf(t.name, m.groups), (count.get(groupOf(t.name, m.groups)) ?? 0) + 1);
  return [...count].sort(([a], [b]) => (a < b ? -1 : 1));
});

async function open(path: string) {
  dir.value = path;
  loaded.value = await window.erd.model.load(path);
  message.value = '';
}

async function pick() {
  const p = await window.erd.model.pickFolder();
  if (p) await open(p);
}

async function save() {
  if (!loaded.value) return;
  // shallowRef 안의 일반 객체라 그대로 IPC 로 보낼 수 있다
  const r = await window.erd.model.save(dir.value, toRaw(loaded.value.model), toRaw(loaded.value.layout));
  message.value = `저장: 바뀐 파일 ${r.written.length}개, 그대로 ${r.unchanged.length}개, 지운 파일 ${r.removed.length}개`;
}

window.__erdOpen = open;
</script>

<template>
  <main class="app">
    <header>
      <button @click="pick">모델 폴더 열기</button>
      <button :disabled="!loaded" @click="save">저장</button>
      <span class="dir">{{ dir }}</span>
    </header>
    <section v-if="loaded">
      <p>테이블 {{ loaded.model.tables.length }}개, FK {{ loaded.model.tables.reduce((n, t) => n + t.fks.length, 0) }}개</p>
      <table>
        <thead><tr><th>No.</th><th>그룹</th><th>테이블 수</th></tr></thead>
        <tbody>
          <tr v-for="([g, n], i) in groups" :key="g"><td>{{ i + 1 }}</td><td>{{ g }}</td><td>{{ n }}</td></tr>
        </tbody>
      </table>
      <p v-if="message">{{ message }}</p>
      <div v-if="loaded.errors.length" class="errors">
        <p>검증 오류 {{ loaded.errors.length }}개</p>
        <ul><li v-for="(e, i) in loaded.errors" :key="i">{{ e.file }}:{{ e.line }} {{ e.message }}</li></ul>
      </div>
      <p v-else>검증 오류 없음</p>
    </section>
  </main>
</template>

<style>
body { margin: 0; font: 14px 'Malgun Gothic', sans-serif; }
.app { padding: 16px; }
header { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.dir { color: #666; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ccc; padding: 4px 10px; }
.errors { color: #b00020; }
</style>
