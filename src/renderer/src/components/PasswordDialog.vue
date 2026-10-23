<script setup lang="ts">
// DB 접속 비밀번호 묻는 창. 입력값(input)은 App 이 가진 객체를 그대로 고친다 (대기열의 다음 요청으로 넘어가면 App 이 비운다)
import { nextTick, ref, watch } from 'vue';

const props = defineProps<{ ask: { id: number; label: string; reason: string }; input: { password: string; save: boolean } }>();
const emit = defineEmits<{ answer: [ok: boolean] }>();

const box = ref<HTMLInputElement>();
// 처음 뜰 때와 대기열의 다음 요청으로 바뀔 때 입력 칸에 포커스
watch(() => props.ask.id, () => { void nextTick(() => box.value?.focus()); }, { immediate: true });
</script>

<template>
  <div class="modal">
    <form class="dialog" @submit.prevent="emit('answer', true)">
      <p><b>{{ ask.label }}</b> 비밀번호</p>
      <p class="warn">{{ ask.reason }}</p>
      <input ref="box" v-model="input.password" type="password" autocomplete="off" class="pw" />
      <label class="save"><input v-model="input.save" type="checkbox" /> 이 PC 에 저장 (Windows 계정 암호화, 다음부터 묻지 않음)</label>
      <div class="row">
        <button type="submit" :disabled="!input.password">접속</button>
        <button type="button" @click="emit('answer', false)">취소</button>
      </div>
    </form>
  </div>
</template>

<style>
.dialog .pw { width: 100%; box-sizing: border-box; margin: 4px 0 8px; }
.dialog .save { display: block; margin-bottom: 10px; font-size: 12px; }
</style>
