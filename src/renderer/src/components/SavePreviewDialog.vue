<script setup lang="ts">
// ERD 저장 전에 새로 만들, 바뀔, 지울 파일 목록을 보여 주는 창
import type { SavePlan } from '../../../shared/ipc';

defineProps<{ preview: { dir: string; plan: SavePlan; otherModel: boolean } }>();
const emit = defineEmits<{ answer: [ok: boolean] }>();
</script>

<template>
  <div class="modal" @keydown.esc="emit('answer', false)">
    <div class="dialog save-preview">
      <p><b>ERD 저장</b> <span class="muted">{{ preview.dir }}</span></p>
      <p v-if="preview.otherModel" class="warn">이 폴더에는 다른 ERD 모델이 있습니다. 이 모델로 덮어씁니다.</p>
      <p v-if="!preview.plan.added.length && !preview.plan.changed.length && !preview.plan.removed.length">바뀌는 파일이 없습니다 (그대로 {{ preview.plan.unchanged.length }}개).</p>
      <template v-for="g in [
        { key: 'added', label: '새로 만듦', cls: 'ok' },
        { key: 'changed', label: '바뀜', cls: '' },
        { key: 'removed', label: '삭제 (이 모델에 없는 모델 파일)', cls: 'warn' },
        { key: 'unchanged', label: '그대로', cls: 'muted' },
      ] as const" :key="g.key">
        <div v-if="preview.plan[g.key].length" class="sp-group" :data-kind="g.key">
          <div :class="g.cls"><b>{{ g.label }} {{ preview.plan[g.key].length }}개</b></div>
          <ul><li v-for="f in preview.plan[g.key]" :key="f">{{ f }}</li></ul>
        </div>
      </template>
      <div class="row">
        <button @click="emit('answer', true)">저장</button>
        <button @click="emit('answer', false)">취소</button>
      </div>
    </div>
  </div>
</template>

<style>
.save-preview { min-width: 420px; max-height: 80vh; display: flex; flex-direction: column; gap: 6px; }
.save-preview p { margin: 0; word-break: break-all; }
.save-preview .sp-group { font-size: 12px; }
.save-preview ul { margin: 2px 0 0; padding-left: 18px; max-height: 140px; overflow: auto; font: 12px Consolas, 'Malgun Gothic', monospace; }
.save-preview .ok { color: var(--ok); } .save-preview .muted { color: var(--muted); }
</style>
