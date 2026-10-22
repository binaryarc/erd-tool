<script setup lang="ts">
// FK 선: 두 테이블 위치에 맞춰 가장 가까운 면을 골라 잇는다 (edge-ends.ts). 테이블을 끌면 그 자리에서 면을 다시 고른다.
// 선 모양(직선, 꺾은선, 곡선)은 보기 설정을 data.kind 로 받는다
import { computed, type PropType } from 'vue';
import { BaseEdge, Position, getBezierPath, getSmoothStepPath, getStraightPath, type GraphNode } from '@vue-flow/core';
import { edgeEnds, type Box, type Side } from '../edge-ends';
import type { EdgeKind } from '../view';

export interface ErdEdgeData {
  kind: EdgeKind;
  compact: boolean;
  /** FK 첫 컬럼의 줄 번호 (자식), 참조 컬럼의 줄 번호 (부모). 못 찾으면 -1 */
  sRow: number;
  tRow: number;
}

defineOptions({ inheritAttrs: false });
const props = defineProps({
  id: { type: String, required: true },
  sourceNode: { type: Object as PropType<GraphNode>, required: true },
  targetNode: { type: Object as PropType<GraphNode>, required: true },
  data: { type: Object as PropType<ErdEdgeData>, required: true },
  markerStart: String,
  markerEnd: String,
  interactionWidth: Number,
});

const POS: Record<Side, Position> = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };
const box = (n: GraphNode): Box => ({ x: n.computedPosition.x, y: n.computedPosition.y, w: n.dimensions.width, h: n.dimensions.height });

const path = computed(() => {
  const { source: s, target: t } = edgeEnds(box(props.sourceNode), box(props.targetNode), props.data.sRow, props.data.tRow, props.data.compact);
  const p = { sourceX: s.x, sourceY: s.y, sourcePosition: POS[s.side], targetX: t.x, targetY: t.y, targetPosition: POS[t.side] };
  return (props.data.kind === 'straight' ? getStraightPath(p) : props.data.kind === 'smoothstep' ? getSmoothStepPath(p) : getBezierPath(p))[0];
});
</script>

<template>
  <BaseEdge :id="id" :path="path" :marker-start="markerStart" :marker-end="markerEnd" :interaction-width="interactionWidth" />
</template>
