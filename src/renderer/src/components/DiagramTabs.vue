<script setup lang="ts">
// ERD 아래 탭 바 (STEP 10): 「전체」 탭과 그룹 탭. + 로 추가, 더블클릭으로 이름 바꾸기, 우클릭으로 탭 삭제(테이블은 모델에 남는다).
// 탭 데이터(layout.json)는 App 이 고친다. 여기서는 사람 입력만 이벤트로 보낸다.
import { nextTick, ref } from 'vue';

const props = defineProps<{ all: string; tabs: string[]; active: string; canPrefix: boolean }>();
const emit = defineEmits<{
  select: [name: string]; add: []; rename: [from: string, to: string]; remove: [name: string]; prefix: []; pick: [];
}>();

const editing = ref('');
const box = ref<HTMLInputElement[]>();
async function startRename(name: string) {
  editing.value = name;
  await nextTick();
  box.value?.[0]?.focus();
  box.value?.[0]?.select();
}
function endRename(e: Event, commit: boolean) {
  const from = editing.value;
  if (!from) return;
  editing.value = '';
  const to = (e.target as HTMLInputElement).value.trim();
  if (commit && to && to !== from) emit('rename', from, to);
}
</script>

<template>
  <nav class="dtabs">
    <button :class="{ on: active === all }" @click="emit('select', all)">{{ all }}</button>
    <template v-for="t in props.tabs" :key="t">
      <input v-if="editing === t" ref="box" class="rename" :value="t" spellcheck="false"
             @keydown.enter="e => endRename(e, true)" @keydown.esc="e => endRename(e, false)" @blur="e => endRename(e, true)" />
      <button v-else :class="{ on: active === t }" :data-tab="t" title="더블클릭: 이름 바꾸기, 우클릭: 탭 삭제 (테이블은 모델에 남습니다)"
              @click="emit('select', t)" @dblclick="startRename(t)" @contextmenu.prevent="emit('remove', t)">{{ t }}</button>
    </template>
    <button class="add" title="빈 그룹 탭을 만듭니다" @click="emit('add')">+</button>
    <button v-if="canPrefix" class="add" title="모델의 접두어 그룹(mst, whs 등)마다 그 그룹 테이블을 넣은 탭을 만듭니다" @click="emit('prefix')">접두어 그룹으로 탭 만들기</button>
    <span class="spacer" />
    <button v-if="active !== all" class="add pick" title="이 그룹에 없는 테이블을 골라 넣습니다 (빈 곳 우클릭과 같습니다)" @click="emit('pick')">테이블 추가</button>
  </nav>
</template>

<style scoped>
.dtabs { display: flex; gap: 2px; align-items: flex-start; padding: 0 6px 4px; border-top: 1px solid var(--line); background: var(--panel-bg); flex: none; overflow-x: auto; }
button, .rename { border: 1px solid var(--line); border-top: none; background: var(--panel-bg); color: var(--fg); padding: 2px 12px; font-size: 12px; cursor: pointer; white-space: nowrap; height: 22px; box-sizing: border-box; }
button.on { background: var(--bg); font-weight: bold; border-color: var(--accent); margin-top: -1px; height: 23px; }
.add { border-style: dashed; border-top-style: none; background: transparent; }
.rename { width: 120px; background: var(--bg); cursor: text; font: 12px 'Malgun Gothic', sans-serif; }
.spacer { flex: 1; }
</style>
