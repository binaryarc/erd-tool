<script setup lang="ts">
// 아래 터미널 영역 (VS Code 터미널처럼): 터미널 탭 여러 개, + PowerShell, + Git Bash, 닫기, 영역 숨기기.
// 「AI 연결」(STEP 8): 지금 터미널에 Claude Code 나 Codex 를 이 앱의 MCP 서버에 붙여 실행하는 명령을 넣는다.
// 그 자리 연결만 한다(사용자 결정 2026-10-16). Claude, Codex 설정 파일은 바꾸지 않는다.
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

const aiError = ref('');

/** AI 를 붙여 실행하는 명령. Codex 의 -c 값은 TOML 로 읽히지 않으면 글자 그대로 쓰여 따옴표 없이 준다(셸마다 따옴표 처리가 달라서) */
async function aiCommand(kind: 'claude' | 'codex'): Promise<string> {
  const info = await window.erd.mcp.info();
  if (!info) throw new Error('AI 연결 서버가 떠 있지 않다 (앱을 다시 켜 보세요)');
  return kind === 'claude'
    ? `claude --mcp-config "${info.claudeConfig}"`
    : `codex -c mcp_servers.erd.url=${info.url} -c mcp_servers.erd.bearer_token_env_var=ERD_MCP_TOKEN`;
}

async function connectAi(kind: 'claude' | 'codex') {
  aiError.value = '';
  try {
    const cmd = await aiCommand(kind);
    if (!active.value) { await add('powershell'); await new Promise(r => setTimeout(r, 1500)); } // 셸이 뜰 때까지
    refs.get(active.value)?.write(cmd + '\r');
  } catch (e) { aiError.value = (e as Error).message; }
}

defineExpose({ add, close, terms, aiCommand, get: (id: string) => refs.get(id), activate: (id: string) => (active.value = id) });
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
      <select class="add" title="지금 터미널에서 AI 를 이 ERD 에 붙여 실행한다 (그 자리 연결, 설정 파일은 바꾸지 않음)"
              @change="e => { const s = e.target as HTMLSelectElement; if (s.value) void connectAi(s.value as 'claude' | 'codex'); s.value = ''; }">
        <option value="">AI 연결 ▾</option>
        <option value="claude">Claude Code</option>
        <option value="codex">Codex</option>
      </select>
      <span v-if="aiError" class="err">{{ aiError }}</span>
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
.err { color: var(--warn); font-size: 12px; margin-left: 6px; }
.body { flex: 1; min-height: 0; position: relative; }
.term { position: absolute; inset: 0; }
.empty { color: #9da5b4; padding: 12px; margin: 0; font-size: 12px; }
</style>
