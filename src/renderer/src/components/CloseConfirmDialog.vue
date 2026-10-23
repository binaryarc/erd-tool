<script setup lang="ts">
// 커밋하지 않은 SQL 탭이 있을 때 탭이나 창을 닫기 전에 묻는 창
defineProps<{ ask: { labels: string[] } }>();
const emit = defineEmits<{ answer: [choice: 'commit' | 'rollback' | 'cancel'] }>();
</script>

<template>
  <div class="modal">
    <div class="dialog">
      <p>커밋하지 않은 변경이 있습니다: <b>{{ ask.labels.join(', ') }}</b></p>
      <div class="row">
        <button @click="emit('answer', 'commit')">커밋하고 닫기</button>
        <button @click="emit('answer', 'rollback')">롤백하고 닫기</button>
        <button @click="emit('answer', 'cancel')">취소</button>
      </div>
    </div>
  </div>
</template>
