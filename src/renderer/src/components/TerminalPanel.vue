<script setup lang="ts">
// 아래 터미널 영역 (VS Code 터미널처럼): 터미널 탭 여러 개, + PowerShell, + Git Bash, 닫기, 영역 숨기기.
import { nextTick, ref } from 'vue';
import TerminalTab from './TerminalTab.vue';
import type { ShellKind } from '../../../shared/ipc';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ hide: []; empty: [] }>();

interface Term { id: string; shell: ShellKind; title: string }
const terms = ref<Term[]>([]);
const active = ref('');
const refs = new Map<string, InstanceType<typeof TerminalTab>>();
let seq = 0;

async function add(shell: ShellKind) {
  const id = `term-${++seq}`;
  terms.value.push({ id, shell, title: shell === 'powershell' ? 'PowerShell' : 'Git Bash' });
  active.value = id;
  await nextTick();
  return id;
}

function close(id: string) {
  terms.value = terms.value.filter(t => t.id !== id);
  if (active.value === id) active.value = terms.value[terms.value.length - 1]?.id ?? '';
  if (!terms.value.length) emit('empty');
}

/** 셸이 정해지면 탭 이름을 실제 셸 이름으로 (PowerShell 7 / Windows PowerShell 5.1) */
function onStarted(id: string, label: string) {
  const t = terms.value.find(x => x.id === id);
  if (t) t.title = label;
}

defineExpose({ add, close, terms, get: (id: string) => refs.get(id), activate: (id: string) => (active.value = id) });
</script>

<template>
  <section class="term-panel">
    <nav class="bar">
      <span class="title">터미널</span>
      <button v-for="t in terms" :key="t.id" class="tab" :class="{ on: t.id === active }" @click="active = t.id">
        {{ t.title }}<span class="x" title="닫기" @click.stop="close(t.id)">×</span>
      </button>
      <button class="add" @click="add('powershell')">+ PowerShell</button>
      <button class="add" @click="add('bash')">+ Git Bash</button>
      <span class="spacer" />
      <button class="add" title="터미널 영역 숨기기 (Ctrl+`)" @click="emit('hide')">숨기기 ▾</button>
    </nav>
    <div class="body">
      <p v-if="!terms.length" class="empty">+ PowerShell 이나 + Git Bash 를 눌러 터미널을 연다. 사용자 홈 폴더에서 시작한다.</p>
      <div v-for="t in terms" v-show="t.id === active" :key="t.id" class="term">
        <TerminalTab :ref="el => (el ? refs.set(t.id, el as InstanceType<typeof TerminalTab>) : refs.delete(t.id))"
                     :term-id="t.id" :shell="t.shell" :active="props.visible && t.id === active" @started="l => onStarted(t.id, l)" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.term-panel { height: 100%; display: flex; flex-direction: column; background: #1e1e1e; }
.bar { display: flex; gap: 2px; align-items: center; padding: 2px 6px; background: var(--panel-bg); border-bottom: 1px solid var(--line); }
.title { font-weight: bold; margin-right: 8px; font-size: 12px; }
.tab, .add { border: 1px solid var(--line); background: var(--bg); color: var(--fg); padding: 2px 8px; cursor: pointer; font-size: 12px; }
.tab.on { border-color: var(--accent); font-weight: bold; }
.add { border-style: dashed; background: transparent; }
.x { margin-left: 6px; color: var(--muted); }
.spacer { flex: 1; }
.body { flex: 1; min-height: 0; position: relative; }
.term { position: absolute; inset: 0; }
.empty { color: #9da5b4; padding: 12px; margin: 0; font-size: 12px; }
</style>
