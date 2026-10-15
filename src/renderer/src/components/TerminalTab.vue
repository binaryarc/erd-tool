<script setup lang="ts">
// 터미널 탭 (설계 11장): xterm.js + fit + unicode11(한글 폭). 셸은 메인이 node-pty 로 띄운다.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { ShellKind } from '../../../shared/ipc';
import { subscribe } from '../terminal-bus';

const props = defineProps<{ termId: string; shell: ShellKind; active: boolean }>();
const el = ref<HTMLDivElement>();
const info = ref('');
const term = new Terminal({ allowProposedApi: true, fontFamily: "D2Coding, Consolas, 'Malgun Gothic', monospace", fontSize: 13, cursorBlink: true });
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';
let unsubscribe = () => {};
let observer: ResizeObserver | undefined;

function refit() {
  if (!el.value || !el.value.offsetWidth) return;
  fit.fit();
  window.erd.term.resize(props.termId, term.cols, term.rows);
}

async function start() {
  try {
    const r = await window.erd.term.spawn(props.termId, props.shell, term.cols, term.rows);
    info.value = `${r.shell} @ ${r.cwd}`;
  } catch (e) {
    term.writeln(`\x1b[31m${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m`);
  }
}

onMounted(async () => {
  term.open(el.value!);
  await nextTick();
  refit();
  unsubscribe = subscribe(props.termId, {
    data: d => term.write(d),
    exit: c => term.writeln(`\r\n\x1b[90m[셸 종료: ${c}] 탭을 닫고 새 터미널을 여세요\x1b[0m`),
  });
  term.onData(d => window.erd.term.input(props.termId, d));
  observer = new ResizeObserver(() => refit());
  observer.observe(el.value!);
  await start();
});

watch(() => props.active, a => { if (a) nextTick(() => { refit(); term.focus(); }); });

onBeforeUnmount(() => {
  observer?.disconnect();
  unsubscribe();
  window.erd.term.kill(props.termId);
  term.dispose();
});

/** 시험용: 화면 버퍼 글자 */
function bufferText() {
  const b = term.buffer.active, out: string[] = [];
  for (let y = 0; y < b.length; y++) { const t = b.getLine(y)?.translateToString(true) ?? ''; if (t.trim()) out.push(t); }
  return out.join('\n');
}
defineExpose({ bufferText, write: (d: string) => window.erd.term.input(props.termId, d) });
</script>

<template>
  <div class="term">
    <div class="bar">{{ info }}</div>
    <div ref="el" class="xterm-box" />
  </div>
</template>

<style scoped>
.term { height: 100%; display: flex; flex-direction: column; background: #1e1e1e; }
.bar { font-size: 11px; color: #9da5b4; padding: 2px 8px; border-bottom: 1px solid #333; }
.xterm-box { flex: 1; min-height: 0; padding: 4px; }
</style>
