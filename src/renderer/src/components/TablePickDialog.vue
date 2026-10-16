<script setup lang="ts">
// 그룹 탭에 기존 테이블 가져오기 (STEP 10): 이 그룹에 없는 테이블만 보여 주고, 이름(물리명, 논리명)으로 찾아 여러 개 골라 한 번에 넣는다.
import { computed, onMounted, ref } from 'vue';

const props = defineProps<{ group: string; tables: { name: string; comment: string }[] }>();
const emit = defineEmits<{ pick: [names: string[]]; close: [] }>();

const q = ref('');
const picked = ref<string[]>([]);
const search = ref<HTMLInputElement>();
onMounted(() => search.value?.focus());

const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  const list = [...props.tables].sort((a, b) => (a.name < b.name ? -1 : 1));
  return k ? list.filter(t => t.name.toLowerCase().includes(k) || t.comment.toLowerCase().includes(k)) : list;
});
const allShown = computed(() => shown.value.length > 0 && shown.value.every(t => picked.value.includes(t.name)));
function toggleAll() {
  const names = shown.value.map(t => t.name);
  picked.value = allShown.value ? picked.value.filter(n => !names.includes(n)) : [...new Set([...picked.value, ...names])];
}
defineExpose({ /** 시험용 */ setQuery: (v: string) => { q.value = v; }, setPicked: (v: string[]) => { picked.value = v; } });
</script>

<template>
  <div class="modal" @mousedown.self="emit('close')">
    <div class="dialog pick">
      <p><b>{{ group }}</b> 에 테이블 추가 <span class="muted">(이 그룹에 없는 테이블 {{ tables.length }}개)</span></p>
      <input ref="search" v-model="q" class="q" placeholder="이름으로 찾기 (물리명, 논리명)" spellcheck="false" @keydown.esc="emit('close')" />
      <label class="all"><input type="checkbox" :checked="allShown" @change="toggleAll" /> 보이는 것 모두 ({{ shown.length }}개)</label>
      <ul>
        <li v-for="t in shown" :key="t.name">
          <label><input v-model="picked" type="checkbox" :value="t.name" /> <b>{{ t.name }}</b> <span class="muted">{{ t.comment }}</span></label>
        </li>
      </ul>
      <div class="row">
        <button :disabled="!picked.length" @click="emit('pick', picked)">{{ picked.length }}개 넣기</button>
        <button @click="emit('close')">취소</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pick { width: 480px; display: flex; flex-direction: column; gap: 6px; }
.pick p { margin: 0; }
.q { width: 100%; box-sizing: border-box; padding: 3px 6px; color: var(--fg); background: var(--bg); border: 1px solid var(--line); }
ul { list-style: none; margin: 0; padding: 4px; height: 320px; overflow: auto; border: 1px solid var(--line); font: 12px Consolas, 'Malgun Gothic', monospace; }
li label { display: block; padding: 1px 2px; cursor: pointer; white-space: nowrap; }
li label:hover { background: var(--sel-bg); }
.all { font-size: 12px; }
.muted { color: var(--muted); font-weight: normal; }
</style>
