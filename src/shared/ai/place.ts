// 「옆에 둬」 자리 찾기 (STEP 8, 사용자 결정 2026-10-16: 빈 곳에 고정).
// 기준 테이블 바로 오른쪽(간격 gap)을 바라는 자리로 두고, 다른 테이블과 겹치지 않는 자리 중 그곳에서 가장 가까운 곳을 고른다.
// 고른 좌표는 그 테이블 하나의 pinned 에만 들어가므로 다른 테이블은 움직이지 않는다.

import type { Box } from './notation';

const STEP = 20;
const RADIUS = 3000;

/** moving 을 target 옆에 둘 좌표. size 는 옮길 테이블의 (바뀐 뒤) 크기 */
export function findSpotNear(boxes: Map<string, Box>, target: string, moving: string, size: { w: number; h: number }, gap = 40): { x: number; y: number } {
  const t = boxes.get(target);
  if (!t) throw new Error(`기준 테이블이 화면에 없다: ${target}`);
  const others = [...boxes].filter(([id]) => id !== moving).map(([, b]) => b);
  // 붙어 보이지 않게 다른 테이블과 gap/2 이상 띄운다
  const m = gap / 2;
  const free = (x: number, y: number) => others.every(b => x + size.w + m <= b.x || b.x + b.w + m <= x || y + size.h + m <= b.y || b.y + b.h + m <= y);
  const want = { x: t.x + t.w + gap, y: t.y };
  if (free(want.x, want.y)) return want;
  let best: { x: number; y: number; d: number } | undefined;
  for (let dx = -RADIUS; dx <= RADIUS; dx += STEP) {
    for (let dy = -RADIUS; dy <= RADIUS; dy += STEP) {
      const d = Math.hypot(dx, dy);
      if (best && d >= best.d) continue;
      const x = want.x + dx, y = want.y + dy;
      if (y < t.y - RADIUS) continue;
      if (free(x, y)) best = { x, y, d };
    }
  }
  if (!best) throw new Error(`${target} 근처 ${RADIUS}px 안에 빈 자리가 없다`);
  return { x: Math.round(best.x), y: Math.round(best.y) };
}
