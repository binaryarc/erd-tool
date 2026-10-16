<script setup lang="ts">
// ERD 캔버스: 테이블 노드, 컬럼끼리 FK 선, 그룹 배경, 미니맵, 확대 축소 버튼.
// 좌표는 배치 방식(diagram.mode)에 따라 그룹 격자(arrange.ts) 또는 FK 트리(tree.ts)로 계산하고, 끌어 옮긴 테이블만 pin 이벤트로 알린다.
// 한 화면에 캔버스가 둘(본 ERD, 미니 ERD) 뜨므로 flowId 로 Vue Flow 상태를 나눈다.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { VueFlow, useVueFlow, type Connection, type Edge, type Node, type NodeDragEvent, type NodeMouseEvent } from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import TableNode, { type TableNodeData } from './TableNode.vue';
import { arrange, tableHeight } from '../../../shared/model/arrange';
import { arrangeTree } from '../../../shared/model/tree';
import { arrangeMode, type Diagram } from '../../../shared/model/layout';
import type { SchemaModel } from '../../../shared/model/types';
import { COMPACT_ZOOM, VIEW_KEY, type ViewState } from '../view';
import { tableWidth } from '../text-width';

const props = withDefaults(defineProps<{
  model: SchemaModel; diagram: Diagram; version: number;
  flowId?: string;
  /** 가운데에 둔 테이블 이름 (미니 ERD 에서 강조) */
  focus?: string;
  showMiniMap?: boolean;
  /** 영역 크기가 바뀔 때마다 전체 보기로 맞춘다 (미니 ERD: 패널이 열리는 순간 폭이 0 이라 처음 맞춤이 틀어진다) */
  fitOnResize?: boolean;
  /** 이 값이 바뀔 때만 전체 보기로 맞춘다 (없으면 모델이 바뀔 때마다). 본 ERD 는 모델을 고칠 때마다 화면이 튀지 않게 불러올 때만 바꾼다 */
  fitKey?: number;
  /** AI 가 바꿔 확정을 기다리는 테이블 ID (주황 테두리, STEP 8) */
  highlight?: Set<string>;
  /** 그룹 탭에서 그리지 않은 FK (테이블 ID → 설명). 테이블 머리에 「외부 FK n개」 배지 (STEP 10) */
  external?: Map<string, string[]>;
  /** 처음 화면 위치. 있으면 전체 보기 대신 이 자리로 연다 (ERD 탭을 오가거나 다시 켤 때, STEP 10) */
  initialViewport?: { x: number; y: number; zoom: number };
  /** 선을 끌어 FK 를 만들 수 있다 (본 ERD 만, STEP 10). canConnect 는 놓기 전 가능 여부 (연결점이 초록으로 붙는다) */
  connectable?: boolean;
  canConnect?: (a: ConnEnd, b: ConnEnd) => boolean;
}>(), { flowId: 'main', showMiniMap: true, fitOnResize: false });
const emit = defineEmits<{
  pin: [id: string, x: number, y: number]; select: [names: string[]]; open: [name: string];
  /** 우클릭 (STEP 10): 테이블 위면 name 이 있고, 빈 곳이면 없다. x, y 는 화면 좌표 */
  menu: [e: { x: number; y: number; name?: string }];
  /** 선을 끌어 놓음 (STEP 10): a 는 끌기 시작한 쪽, b 는 놓은 쪽. 컬럼이 없으면 테이블 머리나 몸통에 놓은 것 */
  connect: [a: ConnEnd, b: ConnEnd];
  /** 고른 FK 선 (테이블 이름, FK 이름) */
  selectFks: [fks: { table: string; fk: string }[]];
}>();
export interface ConnEnd { table: string; column?: string }
const view = inject(VIEW_KEY) as ViewState;

const nodes = computed<Node[]>(() => {
  void props.version; // layout 이 바뀌면 다시 계산
  // 폭은 보기 모드에 따라 바뀐다 (둘 다 보기에서 긴 이름이 잘리지 않게)
  const widths = new Map(props.model.tables.map(t => [t.id, tableWidth(t, view.nameMode, props.external?.get(t.id)?.length ?? 0)]));
  const widthOf = (t: { id: string }) => widths.get(t.id)!;
  let positions: Map<string, { x: number; y: number }>;
  let groupNodes: Node[] = [];
  if (arrangeMode(props.diagram) === 'tree') {
    positions = arrangeTree(props.model, { width: widthOf, height: t => tableHeight(t) });
    for (const [id, [x, y]] of Object.entries(props.diagram.pinned)) if (positions.has(id)) positions.set(id, { x, y });
  } else {
    const r = arrange(props.model, props.diagram, widthOf);
    positions = r.positions;
    groupNodes = r.groups.map(g => ({
      id: 'group:' + g.name, type: 'group', position: { x: g.x, y: g.y }, data: { name: g.name },
      style: { width: `${g.width}px`, height: `${g.height}px` }, draggable: false, selectable: false, zIndex: -1,
    }));
  }
  const tableNodes: Node[] = props.model.tables.map(t => {
    const fkCols = new Set(t.fks.flatMap(f => f.columns));
    const data: TableNodeData = {
      name: t.name, comment: t.comment, width: widths.get(t.id)!, focus: t.name === props.focus, ai: props.highlight?.has(t.id), external: props.external?.get(t.id),
      columns: t.columns.map(c => ({ name: c.name, type: c.type, comment: c.comment, notNull: c.notNull, pk: t.pk.includes(c.name), fk: fkCols.has(c.name) })),
    };
    return { id: t.id, type: 'table', position: positions.get(t.id) ?? { x: 0, y: 0 }, data };
  });
  return [...groupNodes, ...tableNodes];
});

const edges = computed<Edge[]>(() => {
  const idOf = new Map(props.model.tables.map(t => [t.name, t.id]));
  return props.model.tables.flatMap(t => t.fks.filter(f => idOf.has(f.refTable)).map(f => ({
    id: `${t.id}:${f.name}`, source: t.id, target: idOf.get(f.refTable)!, type: view.edgeKind,
    // 축소 보기에서는 컬럼 연결점이 없으니 머리 연결점으로
    sourceHandle: view.compact ? 's-*' : 's-' + f.columns[0],
    targetHandle: view.compact ? 't-*' : 't-' + f.refColumns[0],
  })));
});

const { viewport, setViewport, fitView, findNode, getSelectedNodes, getSelectedEdges } = useVueFlow(props.flowId);
watch(() => getSelectedEdges.value.map(e => e.id).join(','), () => {
  const names = new Map(props.model.tables.map(t => [t.id, t.name]));
  emit('selectFks', getSelectedEdges.value.map(e => { const i = e.id.indexOf(':'); return { table: names.get(e.id.slice(0, i))!, fk: e.id.slice(i + 1) }; }).filter(x => x.table));
});

// ---------- 선 끌어 FK 만들기 (STEP 10) ----------
// 연결점 ID: s-컬럼, t-컬럼 (컬럼 행), s-*, t-* (테이블 머리). 연결점에 놓으면 connect, 테이블 몸통에 놓으면 connect-end 에서 그 테이블을 찾는다
const endOf = (nodeId: string, handle?: string | null): ConnEnd | null => {
  const t = props.model.tables.find(x => x.id === nodeId);
  if (!t) return null;
  const col = handle?.slice(2);
  return col && col !== '*' ? { table: t.name, column: col } : { table: t.name };
};
const validConn = (c: Connection) => {
  const a = endOf(c.source, c.sourceHandle), b = endOf(c.target, c.targetHandle);
  return !!a && !!b && (props.canConnect?.(a, b) ?? false);
};
let start: ConnEnd | null = null;
let connected = false;
function onConnectStart(p: { nodeId?: string; handleId: string | null }) {
  start = p.nodeId ? endOf(p.nodeId, p.handleId) : null;
  connected = false;
}
function onConnect(c: Connection) {
  const a = endOf(c.source, c.sourceHandle), b = endOf(c.target, c.targetHandle);
  if (!a || !b) return;
  connected = true;
  emit('connect', a, b);
}
function onConnectEnd(e?: MouseEvent | TouchEvent) {
  const s = start;
  start = null;
  if (connected || !s || !e || !('clientX' in e)) return;
  // 연결점이 아닌 곳에 놓았다: 그 자리의 테이블 (자기 자신이면 아무것도 하지 않는다)
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.vue-flow__node-table');
  const t = el && props.model.tables.find(x => x.id === el.dataset.id);
  if (t && t.name !== s.table) emit('connect', s, { table: t.name });
}
// Ctrl+클릭으로 고른 테이블 → 「SELECT 만들기」 (설계 9장 4번)
watch(() => getSelectedNodes.value.map(n => n.id).join(','), () => {
  const names = new Map(props.model.tables.map(t => [t.id, t.name]));
  emit('select', getSelectedNodes.value.filter(n => n.type === 'table').map(n => names.get(n.id)!).filter(Boolean));
});
watch([() => viewport.value.zoom, () => view.compactOnZoomOut], ([z, on]) => { view.compact = on && z < COMPACT_ZOOM; });
// 다른 모델로 바뀌거나 배치 방식이 바뀌면 전체가 보이게 맞춘다.
// diagram 은 반응형이 아니라(layout 을 그대로 IPC 로 보내므로) version 이 바뀔 때 방식이 달라졌는지 직접 비교한다
let lastMode = arrangeMode(props.diagram);
async function refit() {
  await nextTick();
  setTimeout(() => fitView({ padding: 0.15, maxZoom: 1 }), 50); // 테이블이 적은 그룹 탭이 화면 가득 커지지 않게
}
watch(() => props.fitKey ?? props.model, refit);

const box = ref<HTMLDivElement>();
let observer: ResizeObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  if (!props.fitOnResize || !box.value) return;
  observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (box.value!.clientWidth > 50) void fitView({ padding: 0.15 }); }, 120);
  });
  observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());
watch(() => props.version, () => {
  if (arrangeMode(props.diagram) === lastMode) return;
  lastMode = arrangeMode(props.diagram);
  void refit();
});

function onDragStop(e: NodeDragEvent) {
  for (const n of e.nodes) if (n.type === 'table') emit('pin', n.id, Math.round(n.position.x), Math.round(n.position.y));
}

function onNodeMenu(e: NodeMouseEvent) {
  if (e.node.type !== 'table') return;
  const ev = e.event as MouseEvent;
  ev.preventDefault();
  emit('menu', { x: ev.clientX, y: ev.clientY, name: (e.node.data as TableNodeData).name });
}
function onPaneMenu(ev: MouseEvent) {
  ev.preventDefault();
  emit('menu', { x: ev.clientX, y: ev.clientY });
}

function onDoubleClick(e: NodeMouseEvent) {
  if (e.node.type !== 'table') return;
  emit('open', (e.node.data as TableNodeData).name);
}

/** 시험용: duration 동안 화면 이동, 확대, 첫 테이블 끌기를 흉내 내며 프레임을 센다 (STEP 1 측정과 같은 방식) */
async function bench(duration = 4000, zoomRange: [number, number] = [0.3, 1.0]) {
  const first = props.model.tables[0];
  const node = first ? findNode(first.id) : undefined;
  const base = node ? { ...node.position } : { x: 0, y: 0 };
  const start = performance.now();
  let frames = 0, worst = 0, last = start;
  return new Promise<{ avgFps: number; worstFrameMs: number }>(resolve => {
    function step(now: number) {
      frames++; worst = Math.max(worst, now - last); last = now;
      const p = (now - start) / duration;
      const zoom = zoomRange[0] + (zoomRange[1] - zoomRange[0]) * Math.abs(Math.sin(p * Math.PI * 2));
      setViewport({ x: 200 - 1500 * zoom * p, y: 50 - 1200 * zoom * p, zoom });
      if (node) node.position = { x: base.x + 300 * Math.sin(p * Math.PI * 4), y: base.y + 200 * p };
      if (now - start < duration) requestAnimationFrame(step);
      else {
        if (node) node.position = base;
        resolve({ avgFps: Math.round(frames / (duration / 1000)), worstFrameMs: Math.round(worst) });
      }
    }
    requestAnimationFrame(step);
  });
}

/** 이름으로 테이블을 찾아 화면 가운데로 옮긴다 */
async function focusTable(name: string) {
  const t = props.model.tables.find(x => x.name === name);
  if (t) await fitView({ nodes: [t.id], maxZoom: 1, padding: 0.4 });
}

/** 테이블 ID 별 화면 사각형과 확대 배율 (AI 의 erd_view_state) */
function boxes() {
  const m = new Map<string, { x: number; y: number; w: number; h: number }>();
  const byId = new Map(props.model.tables.map(t => [t.id, t]));
  for (const n of nodes.value) {
    const t = byId.get(n.id);
    if (t) m.set(n.id, { x: n.position.x, y: n.position.y, w: (n.data as TableNodeData).width, h: tableHeight(t, view.compact) });
  }
  return m;
}

defineExpose({ bench, fitView, focusTable, boxes, zoom: () => viewport.value.zoom, viewportNow: () => ({ ...viewport.value }) });
</script>

<template>
  <div ref="box" class="erd-box">
  <VueFlow :id="flowId" :nodes="nodes" :edges="edges" :min-zoom="0.05" :max-zoom="2" multi-selection-key-code="Control"
           :zoom-on-double-click="false" :delete-key-code="null" :fit-view-on-init="!initialViewport" :default-viewport="initialViewport" :nodes-connectable="connectable" :is-valid-connection="validConn" :connection-radius="24"
           @connect="onConnect" @connect-start="onConnectStart" @connect-end="onConnectEnd" @node-drag-stop="onDragStop" @node-double-click="onDoubleClick"
           @node-context-menu="onNodeMenu" @pane-context-menu="onPaneMenu">
    <template #node-table="{ data }">
      <TableNode :data="data" />
    </template>
    <template #node-group="{ data }">
      <div class="group-box"><span>{{ data.name }}</span></div>
    </template>
    <MiniMap v-if="showMiniMap" pannable zoomable />
    <Controls />
  </VueFlow>
  </div>
</template>

<style>
.erd-box { width: 100%; height: 100%; }
.vue-flow__node-group { background: var(--group-bg); border: 1px dashed var(--group-border); border-radius: 6px; padding: 0; }
.group-box { width: 100%; height: 100%; }
.group-box span { display: inline-block; margin: 6px 10px; font: bold 16px 'Malgun Gothic', sans-serif; color: var(--muted); }
.vue-flow__edge-path { stroke: var(--edge); }
/* 한 번 클릭한(선택한) 테이블은 두꺼운 테두리. outline 은 크기를 바꾸지 않아 선 위치가 그대로다 */
.vue-flow__node-table.selected .tbl { outline: 3px solid var(--accent); outline-offset: 1px; }
.vue-flow__node-table.selected { z-index: 10 !important; }
.vue-flow__edge.selected .vue-flow__edge-path { stroke: var(--accent); stroke-width: 2; }
</style>
