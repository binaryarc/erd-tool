<script setup>
// exerd 모양 테이블 노드: 머리(물리명, 논리명), 몸통(컬럼 행). 컬럼 행마다 좌우 연결점을 둔다.
import { Handle, Position } from '@vue-flow/core';
defineProps(['data']);
</script>

<template>
  <div class="tbl">
    <div class="head">
      <b>{{ data.name }}</b>
      <span v-if="data.comment">{{ data.comment }}</span>
    </div>
    <div v-for="c in data.columns" :key="c.name" class="row" :class="{ pk: c.pk }">
      <Handle :id="'t-' + c.name" type="target" :position="Position.Left" class="h" />
      <span class="key">{{ c.pk ? 'PK' : '' }}{{ c.fk ? 'FK' : '' }}</span>
      <span class="name">{{ c.name }}</span>
      <span class="type">{{ c.type }}</span>
      <Handle :id="'s-' + c.name" type="source" :position="Position.Right" class="h" />
    </div>
  </div>
</template>

<style scoped>
.tbl { background: #fff; border: 1px solid #6b8fb8; font: 11px/1.5 Consolas, 'Malgun Gothic', monospace; min-width: 220px; }
.head { background: #dbe7f5; border-bottom: 1px solid #6b8fb8; padding: 2px 6px; display: flex; gap: 6px; }
.head span { color: #555; }
.row { position: relative; display: flex; gap: 6px; padding: 0 6px; }
.row.pk { background: #fff8d6; }
.key { width: 28px; color: #b26b00; font-weight: bold; }
.name { flex: 1; }
.type { color: #777; }
.h { width: 6px; height: 6px; min-width: 0; min-height: 0; opacity: 0; }
</style>
