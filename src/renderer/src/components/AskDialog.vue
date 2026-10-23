<script setup lang="ts">
// 글과 버튼 여러 개로 묻는 공용 창. 누른 버튼의 value 를 돌려준다
defineProps<{ dlg: { text: string; buttons: { label: string; value: string }[] } }>();
const emit = defineEmits<{ answer: [value: string] }>();
</script>

<template>
  <div class="modal">
    <div class="dialog ask">
      <p>{{ dlg.text }}</p>
      <div class="row">
        <button v-for="b in dlg.buttons" :key="b.label" @click="emit('answer', b.value)">{{ b.label }}</button>
      </div>
    </div>
  </div>
</template>

<style>
.dialog.ask p { white-space: pre-line; margin-top: 0; }
</style>
