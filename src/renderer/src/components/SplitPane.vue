<script setup lang="ts">
// 두 영역 사이 경계선을 끌어 크기를 바꾼다. 한쪽(fixed) 크기를 px 로 두고 나머지가 채운다.
// 크기는 storageKey 로 이 PC 에 기억한다 (localStorage, 못 쓰면 기억만 안 함).
import { onBeforeUnmount, ref } from 'vue';

const props = withDefaults(defineProps<{
  /** row: 좌우로 나눔(경계선 세로), col: 위아래로 나눔(경계선 가로) */
  dir: 'row' | 'col';
  /** 크기가 고정되는 쪽 */
  fixed?: 'first' | 'second';
  initial: number;
  min?: number;
  max?: number;
  storageKey?: string;
  /** true 면 고정 쪽을 숨기고 경계선도 없앤다 */
  hideFixed?: boolean;
}>(), { fixed: 'first', min: 80, max: 4000 });

const emit = defineEmits<{ resized: [size: number] }>();

function load(): number {
  try {
    const v = props.storageKey ? Number(localStorage.getItem('split:' + props.storageKey)) : NaN;
    return Number.isFinite(v) && v > 0 ? v : props.initial;
  } catch { return props.initial; }
}

const size = ref(load());
const root = ref<HTMLDivElement>();
let drag: { start: number; size: number } | null = null;

const clamp = (v: number) => {
  const total = props.dir === 'row' ? root.value!.clientWidth : root.value!.clientHeight;
  return Math.round(Math.min(Math.max(v, props.min), Math.min(props.max, total - 60)));
};

// 끄는 동안은 창 전체에서 움직임을 받는다. 경계선(4px)에서만 받으면 마우스가 벗어나는 순간 놓친다
// (편집기, 터미널, 캔버스 위로 지나갈 때도 마찬가지)
function down(e: PointerEvent) {
  e.preventDefault();
  drag = { start: props.dir === 'row' ? e.clientX : e.clientY, size: size.value };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('blur', up);
  document.body.style.cursor = props.dir === 'row' ? 'col-resize' : 'row-resize';
  document.body.style.userSelect = 'none';
}

function move(e: PointerEvent) {
  if (!drag) return;
  const delta = (props.dir === 'row' ? e.clientX : e.clientY) - drag.start;
  size.value = clamp(drag.size + (props.fixed === 'first' ? delta : -delta));
}

function up() {
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', up);
  window.removeEventListener('blur', up);
  if (!drag) return;
  drag = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  try { if (props.storageKey) localStorage.setItem('split:' + props.storageKey, String(size.value)); } catch { /* 기억 못 함 */ }
  emit('resized', size.value);
}

onBeforeUnmount(up);

// 고정 쪽도 줄어들 수 있게 둔다(flex-shrink 1). 기억해 둔 크기가 지금 창보다 크거나 창을 줄였을 때
// 반대쪽이 0 이 되어 사라지지 않게 하기 위해서다 (반대쪽은 최소 60px, 아래 CSS)
const fixedStyle = () => ({ flex: `0 1 ${size.value}px` });
defineExpose({ setSize: (v: number) => (size.value = v) });
</script>

<template>
  <div ref="root" class="split" :class="dir">
    <!-- 숨길 때 v-show 를 쓴다: 안의 터미널, 편집기가 꺼지지 않게 -->
    <div v-show="!(hideFixed && fixed === 'first')" class="pane" :class="{ grow: fixed !== 'first' }" :style="fixed === 'first' ? fixedStyle() : {}">
      <slot name="first" />
    </div>
    <div v-show="!hideFixed" class="handle" @pointerdown="down" />
    <div v-show="!(hideFixed && fixed === 'second')" class="pane" :class="{ grow: fixed !== 'second' }" :style="fixed === 'second' ? fixedStyle() : {}">
      <slot name="second" />
    </div>
  </div>
</template>

<style scoped>
.split { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; }
.split.row { flex-direction: row; }
.split.col { flex-direction: column; }
.pane { flex: none; min-width: 0; min-height: 0; overflow: hidden; position: relative; display: flex; flex-direction: column; }
.pane.grow { flex: 1 1 0; }
.row > .pane.grow { min-width: 60px; }
.col > .pane.grow { min-height: 60px; }
.handle { flex: none; background: var(--line); }
.row > .handle { width: 4px; cursor: col-resize; }
.col > .handle { height: 4px; cursor: row-resize; }
.handle:hover { background: var(--accent); }
</style>
