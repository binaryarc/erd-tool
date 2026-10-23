<script setup lang="ts">
// 테이블, 빈 곳을 오른쪽 클릭하면 뜨는 메뉴. 고른 항목은 emit 으로 알리고, 메뉴 닫기와 실행은 App 의 runMenu 가 한다
import { DEFAULT_DIAGRAM } from '../../../shared/model/arrange';

defineProps<{ menu: { x: number; y: number; names: string[] }; groups: string[]; tab: string }>();
const emit = defineEmits<{
  addToGroup: [group: string];
  newGroup: [];
  removeFromGroup: [];
  edit: [];
  remove: [];
  pickTables: [];
  newTable: [];
}>();
</script>

<template>
  <div class="ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @contextmenu.prevent>
    <template v-if="menu.names.length">
      <div class="ctx-title">{{ menu.names.length === 1 ? menu.names[0] : `테이블 ${menu.names.length}개` }}</div>
      <div class="ctx-sub">그룹에 추가</div>
      <button v-for="g in groups" :key="g" class="ind" @click="emit('addToGroup', g)">{{ g }}</button>
      <button class="ind" @click="emit('newGroup')">새 그룹 만들어 추가</button>
      <button v-if="tab !== DEFAULT_DIAGRAM" @click="emit('removeFromGroup')">이 그룹에서 빼기 (모델에는 남김)</button>
      <button v-if="menu.names.length === 1" @click="emit('edit')">테이블 편집</button>
      <button class="danger" @click="emit('remove')">모델에서 삭제 (Delete)</button>
    </template>
    <template v-else>
      <button v-if="tab !== DEFAULT_DIAGRAM" @click="emit('pickTables')">테이블 추가 (이 그룹에 없는 테이블)</button>
      <button @click="emit('newTable')">새 테이블</button>
    </template>
  </div>
</template>

<style>
.ctx { position: fixed; z-index: 60; min-width: 200px; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); padding: 3px 0; font-size: 12px; }
.ctx button { text-align: left; border: none; background: transparent; color: var(--fg); padding: 3px 12px; cursor: pointer; }
.ctx button:hover { background: var(--sel-bg); }
.ctx .ind { padding-left: 24px; }
.ctx .danger { color: var(--warn); }
.ctx-title { padding: 2px 12px 4px; font-weight: bold; border-bottom: 1px solid var(--line); margin-bottom: 2px; }
.ctx-sub { padding: 2px 12px; color: var(--muted); }
</style>
