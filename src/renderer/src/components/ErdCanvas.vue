<script setup lang="ts">
// ERD 캔버스: 테이블 노드, 컬럼끼리 FK 선, 그룹 배경, 미니맵, 확대 축소 버튼.
// 좌표는 arrange.ts 가 layout 규칙으로 계산하고, 끌어 옮긴 테이블만 pin 이벤트로 알린다.
import { computed, inject, watch } from 'vue';
import { VueFlow, useVueFlow, type Edge, type Node, type NodeDragEvent } from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import TableNode, { type TableNodeData } from './TableNode.vue';
import { arrange } from '../../../shared/model/arrange';
import type { Diagram } from '../../../shared/model/layout';
import type { SchemaModel } from '../../../shared/model/types';
import { COMPACT_ZOOM, VIEW_KEY, type ViewState } from '../view';
import { tableWidth } from '../text-width';

const props = defineProps<{ model: SchemaModel; diagram: Diagram; version: number }>();
const emit = defineEmits<{ pin: [id: string, x: number, y: number] }>();
const view = inject(VIEW_KEY) as ViewState;

const nodes = computed<Node[]>(() => {
  void props.version; // layout 이 바뀌면 다시 계산
  // 폭은 보기 모드에 따라 바뀐다 (둘 다 보기에서 긴 이름이 잘리지 않게)
  const widths = new Map(props.model.tables.map(t => [t.id, tableWidth(t, view.nameMode)]));
  const { positions, groups } = arrange(props.model, props.diagram, t => widths.get(t.id)!);
  const groupNodes: Node[] = groups.map(g => ({
    id: 'group:' + g.name, type: 'group', position: { x: g.x, y: g.y }, data: { name: g.name },
    style: { width: `${g.width}px`, height: `${g.height}px` }, draggable: false, selectable: false, zIndex: -1,
  }));
  const tableNodes: Node[] = props.model.tables.map(t => {
    const fkCols = new Set(t.fks.flatMap(f => f.columns));
    const data: TableNodeData = {
      name: t.name, comment: t.comment, width: widths.get(t.id)!,
      columns: t.columns.map(c => ({ name: c.name, type: c.type, comment: c.comment, notNull: c.notNull, pk: t.pk.includes(c.name), fk: fkCols.has(c.name) })),
    };
    return { id: t.id, type: 'table', position: positions.get(t.id) ?? { x: 0, y: 0 }, data };
  });
  return [...groupNodes, ...tableNodes];
});

const edges = computed<Edge[]>(() => {
  const idOf = new Map(props.model.tables.map(t => [t.name, t.id]));
  return props.model.tables.flatMap(t => t.fks.filter(f => idOf.has(f.refTable)).map(f => ({
    id: `${t.id}:${f.name}`, source: t.id, target: idOf.get(f.refTable)!, type: 'smoothstep',
    // 축소 보기에서는 컬럼 연결점이 없으니 머리 연결점으로
    sourceHandle: view.compact ? 's-*' : 's-' + f.columns[0],
    targetHandle: view.compact ? 't-*' : 't-' + f.refColumns[0],
  })));
});

const { viewport, setViewport, fitView, findNode } = useVueFlow();
watch([() => viewport.value.zoom, () => view.compactOnZoomOut], ([z, on]) => { view.compact = on && z < COMPACT_ZOOM; });

function onDragStop(e: NodeDragEvent) {
  for (const n of e.nodes) if (n.type === 'table') emit('pin', n.id, Math.round(n.position.x), Math.round(n.position.y));
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

defineExpose({ bench, fitView });
</script>

<template>
  <VueFlow :nodes="nodes" :edges="edges" :min-zoom="0.05" :max-zoom="2"
           fit-view-on-init @node-drag-stop="onDragStop">
    <template #node-table="{ data }">
      <TableNode :data="data" />
    </template>
    <template #node-group="{ data }">
      <div class="group-box"><span>{{ data.name }}</span></div>
    </template>
    <MiniMap pannable zoomable />
    <Controls />
  </VueFlow>
</template>

<style>
.vue-flow__node-group { background: var(--group-bg); border: 1px dashed var(--group-border); border-radius: 6px; padding: 0; }
.group-box { width: 100%; height: 100%; }
.group-box span { display: inline-block; margin: 6px 10px; font: bold 16px 'Malgun Gothic', sans-serif; color: var(--muted); }
.vue-flow__edge-path { stroke: var(--edge); }
</style>
