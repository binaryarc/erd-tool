<script setup lang="ts">
// exerd 모양 테이블 노드: 머리(물리명, 논리명), 몸통(PK, FK 표시와 컬럼). 컬럼 행마다 좌우 연결점.
// 크기는 shared/model/arrange.ts 의 NODE 와 같아야 한다 (배치 계산에 쓴다).
import { inject } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import { VIEW_KEY, type ViewState } from '../view';

export interface TableNodeData {
  name: string;
  comment: string;
  /** 내용에 맞춘 폭 (text-width.ts 가 계산) */
  width: number;
  /** 미니 ERD 가운데 테이블 */
  focus?: boolean;
  columns: { name: string; type: string; comment?: string; pk: boolean; fk: boolean; notNull: boolean }[];
}

defineProps<{ data: TableNodeData }>();
const view = inject(VIEW_KEY) as ViewState;

const title = (d: TableNodeData) =>
  view.nameMode === 'physical' ? d.name : view.nameMode === 'logical' ? d.comment || d.name : d.name;
const colName = (c: TableNodeData['columns'][number]) =>
  view.nameMode === 'logical' ? c.comment || c.name : c.name;
</script>

<template>
  <div class="tbl" :class="{ compact: view.compact, focus: data.focus }" :style="{ width: data.width + 'px' }">
    <div class="head" :title="data.comment">
      <b>{{ title(data) }}</b>
      <span v-if="view.nameMode === 'both' && data.comment" class="logical">{{ data.comment }}</span>
    </div>
    <template v-if="!view.compact">
      <div v-for="c in data.columns" :key="c.name" class="row" :class="{ pk: c.pk }" :title="c.comment">
        <Handle :id="'t-' + c.name" type="target" :position="Position.Left" class="h" />
        <!-- 키 표시: PK, FK, NN(NOT NULL). PK 는 NOT NULL 이 당연해 NN 을 따로 적지 않는다 -->
        <span class="key"><i v-if="c.pk" class="pk">PK</i><i v-if="c.fk" class="fk">FK</i><i v-if="c.notNull && !c.pk" class="nn">NN</i></span>
        <span class="name" :class="{ nn: c.notNull }">{{ colName(c) }}</span>
        <span v-if="view.nameMode === 'both' && c.comment" class="logical">{{ c.comment }}</span>
        <span class="type">{{ c.type }}</span>
        <Handle :id="'s-' + c.name" type="source" :position="Position.Right" class="h" />
      </div>
    </template>
    <template v-else>
      <!-- 축소 보기: 컬럼 행을 숨겨도 선이 이어지도록 연결점을 머리에 하나씩 둔다 -->
      <Handle id="t-*" type="target" :position="Position.Left" class="h" />
      <Handle id="s-*" type="source" :position="Position.Right" class="h" />
    </template>
  </div>
</template>

<style scoped>
.tbl { box-sizing: border-box; background: var(--node-bg); border: 1px solid var(--node-border); font: 11px/18px Consolas, 'Malgun Gothic', monospace; color: var(--fg); }
.head { height: 24px; box-sizing: border-box; background: var(--node-head); border-bottom: 1px solid var(--node-border); padding: 0 6px; display: flex; gap: 6px; align-items: center; overflow: hidden; white-space: nowrap; }
.compact .head { border-bottom: none; height: 22px; }
.logical { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
.row { position: relative; height: 18px; display: flex; gap: 6px; padding: 0 6px; white-space: nowrap; overflow: hidden; }
.row.pk { background: var(--pk-bg); }
/* 배지 칸 폭은 text-width.ts 의 KEY 와 같아야 한다 (배지 둘: PK+FK 또는 FK+NN) */
.key { width: 38px; flex: none; display: flex; gap: 2px; align-items: center; }
.key i { font: bold 9px/12px Consolas, monospace; font-style: normal; padding: 0 2px; border-radius: 2px; }
.key .pk { color: #7a4b00; background: #ffd970; }
.key .fk { color: #0b4f8a; background: #bcdcff; }
.key .nn { color: var(--muted); border: 1px solid var(--line); line-height: 10px; }
.tbl.focus { box-shadow: 0 0 0 3px var(--warn); }
/* 폭은 내용에 맞춰 계산되므로 이름은 줄이지 않는다. 최대 폭에 걸리면 논리명부터 줄어든다 */
.name { flex: none; }
.row .logical { flex: 1; min-width: 0; }
.row .name + .type { margin-left: auto; }
.name.nn { font-weight: bold; }
.type { color: var(--muted); flex: none; }
.h { width: 6px; height: 6px; min-width: 0; min-height: 0; opacity: 0; }
</style>
