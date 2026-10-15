<script setup>
// Vue Flow 시험: test DB 구조(117개 테이블)를 접두어 그룹 격자로 놓고, 컬럼끼리 FK 선을 잇는다.
// window.__bench() 로 화면 이동, 확대, 노드 끌기 중 평균 fps 를 잰다.
import { ref, markRaw } from 'vue';
import { VueFlow, useVueFlow } from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import TableNode from './TableNode.vue';
import catalog from '../../format/catalog.json';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/minimap/dist/style.css';

const ROW_H = 17, HEAD_H = 22, W = 300, GAP = 40, COLS = 12;
const nodeTypes = { table: markRaw(TableNode) };
const onlyVisible = new URLSearchParams(location.search).has('visible'); // ?visible 이면 보이는 노드만 그림
const nodes = ref([]);
const edges = ref([]);

const entries = Object.entries(catalog.tables).sort(([a], [b]) => a.localeCompare(b));
const colTop = Array(COLS).fill(0);
entries.forEach(([name, t], i) => {
  const fkCols = new Set(t.fks.flatMap(f => f.columns));
  const columns = Object.entries(t.columns).map(([cn, c]) => ({ name: cn, type: c.type, pk: t.pk.includes(cn), fk: fkCols.has(cn) }));
  const col = i % COLS;
  nodes.value.push({ id: name, type: 'table', position: { x: col * (W + GAP), y: colTop[col] }, data: { name, comment: t.comment, columns } });
  colTop[col] += HEAD_H + columns.length * ROW_H + GAP;
  for (const f of t.fks) {
    edges.value.push({
      id: f.name, source: name, target: f.refTable, type: 'smoothstep',
      sourceHandle: 's-' + f.columns[0], targetHandle: 't-' + f.refColumns[0],
    });
  }
});

const { setViewport, getViewport, findNode } = useVueFlow();

// rAF 프레임 수를 세면서 duration 동안 화면 이동, 확대, 첫 노드 끌기를 흉내 낸다
async function bench(duration = 4000) {
  const start = performance.now();
  const node = findNode(nodes.value[0].id);
  const base = { ...node.position };
  let frames = 0, worst = 0, last = start;
  return new Promise(resolve => {
    function step(now) {
      frames++; worst = Math.max(worst, now - last); last = now;
      const p = (now - start) / duration;
      // 테이블이 계속 화면에 보이는 범위에서 이동과 확대를 반복한다
      const zoom = 0.3 + 0.7 * Math.abs(Math.sin(p * Math.PI * 2));
      setViewport({ x: 200 - 1500 * zoom * p, y: 50 - 1200 * zoom * p, zoom });
      node.position = { x: base.x + 300 * Math.sin(p * Math.PI * 4), y: base.y + 200 * p };
      if (now - start < duration) requestAnimationFrame(step);
      else resolve({ nodes: nodes.value.length, edges: edges.value.length, handles: document.querySelectorAll('.vue-flow__handle').length,
        avgFps: Math.round(frames / (duration / 1000)), worstFrameMs: Math.round(worst) });
    }
    requestAnimationFrame(step);
  });
}
window.__bench = bench;
window.__edgesRendered = () => document.querySelectorAll('.vue-flow__edge').length;
</script>

<template>
  <div style="width:100vw;height:100vh">
    <VueFlow :nodes="nodes" :edges="edges" :node-types="nodeTypes" :min-zoom="0.05" fit-view-on-init
             :only-render-visible-elements="onlyVisible">
      <MiniMap pannable zoomable />
    </VueFlow>
  </div>
</template>
