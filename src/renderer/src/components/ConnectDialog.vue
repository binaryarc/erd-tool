<script setup lang="ts">
// 선을 끌어 FK 를 만들 때 이름, 자식 컬럼, ON DELETE 를 고르는 확인 창. 고른 값(ask)은 App 이 가진 객체를 그대로 고친다
import type { ConnectPlan } from '../../../shared/model/connect';
import type { FkAction } from '../../../shared/model/types';

defineProps<{
  ask: { plan: Extract<ConnectPlan, { ok: true }>; fkName: string; childColumn: string; onDelete: FkAction | '' };
  /** 「새 컬럼」 고르기 값 */
  newCol: string;
}>();
const emit = defineEmits<{ answer: [ok: boolean] }>();
</script>

<template>
  <div class="modal" @keydown.esc="emit('answer', false)">
    <form class="dialog conn" @submit.prevent="emit('answer', true)">
      <p><b>FK 만들기</b>: {{ ask.plan.child }} → {{ ask.plan.parent }}({{ ask.plan.parentColumn }} {{ ask.plan.parentType }})</p>
      <label>FK 이름 <input v-model="ask.fkName" spellcheck="false" /></label>
      <label>{{ ask.plan.child }} 컬럼
        <select v-model="ask.childColumn">
          <option :value="newCol">새 컬럼 {{ ask.plan.newColumn }} ({{ ask.plan.parentType }}, NULL 허용)</option>
          <option v-for="c in ask.plan.childOptions" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }}){{ c.type !== ask.plan.parentType ? ' 타입 다름' : '' }}</option>
        </select>
      </label>
      <label>ON DELETE
        <select v-model="ask.onDelete">
          <option value="">NO ACTION (기본)</option>
          <option value="restrict">RESTRICT</option>
          <option value="cascade">CASCADE</option>
          <option value="set null">SET NULL</option>
          <option value="set default">SET DEFAULT</option>
        </select>
      </label>
      <div class="row">
        <button type="submit" :disabled="!ask.fkName.trim()">만들기</button>
        <button type="button" @click="emit('answer', false)">취소</button>
      </div>
    </form>
  </div>
</template>

<style>
.dialog.conn { display: flex; flex-direction: column; gap: 8px; min-width: 420px; }
.dialog.conn p { margin: 0; }
.dialog.conn label { display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 8px; font-size: 12px; }
.dialog.conn input, .dialog.conn select { color: var(--fg); background: var(--bg); border: 1px solid var(--line); padding: 2px 4px; font: 12px Consolas, 'Malgun Gothic', monospace; }
</style>
