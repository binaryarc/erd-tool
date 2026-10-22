// FK 선의 두 끝 (2026-10-22 사용자 요청): 두 테이블 위치를 보고 가장 가까운 면(왼쪽, 오른쪽, 위, 아래)을 골라 잇는다.
// 전에는 늘 자식 컬럼의 오른쪽에서 나가 부모 컬럼의 왼쪽으로 들어가, 부모가 바로 위에 있거나 왼쪽에 있으면 선이 길게 돌았다.
// 왼쪽, 오른쪽은 FK 컬럼 줄 높이에서, 위, 아래는 테이블 가운데에서 나간다 (위, 아래 면에는 컬럼 줄이 없다).

import { NODE } from '../../shared/model/arrange';

export type Side = 'left' | 'right' | 'top' | 'bottom';
/** 테이블 노드의 캔버스 위 사각형 (왼쪽 위, 폭, 높이) */
export interface Box { x: number; y: number; w: number; h: number }
export interface EdgeEnd { x: number; y: number; side: Side }

/** 테두리 1px. 크기는 TableNode.vue 와 같아야 한다 */
const BORDER = 1;
/** 축소 보기의 머리 높이 (TableNode.vue 의 .compact .head) */
const COMPACT_HEAD = 22;

/** n번째 컬럼 줄의 가운데 높이. 축소 보기이거나 컬럼을 못 찾으면(-1) 머리 가운데 */
export function rowY(b: Box, index: number, compact: boolean): number {
  if (compact || index < 0) return b.y + BORDER + (compact ? COMPACT_HEAD : NODE.headHeight) / 2;
  return b.y + BORDER + NODE.headHeight + index * NODE.rowHeight + NODE.rowHeight / 2;
}

/**
 * 자식(FK 를 가진 쪽)에서 부모(참조되는 쪽)로 가는 선의 두 끝.
 * 위아래 틈이 좌우 틈보다 크면 위, 아래 면으로 잇고, 아니면 왼쪽, 오른쪽 면으로 잇는다.
 * 두 테이블이 겹치면 가운데가 어느 쪽인지로 왼쪽, 오른쪽을 정한다
 */
export function edgeEnds(child: Box, parent: Box, childRow: number, parentRow: number, compact: boolean): { source: EdgeEnd; target: EdgeEnd } {
  const hGap = Math.max(parent.x - (child.x + child.w), child.x - (parent.x + parent.w));
  const vGap = Math.max(parent.y - (child.y + child.h), child.y - (parent.y + parent.h));
  if (vGap > 0 && vGap > hGap) {
    const cx = child.x + child.w / 2, px = parent.x + parent.w / 2;
    return parent.y < child.y
      ? { source: { x: cx, y: child.y, side: 'top' }, target: { x: px, y: parent.y + parent.h, side: 'bottom' } }
      : { source: { x: cx, y: child.y + child.h, side: 'bottom' }, target: { x: px, y: parent.y, side: 'top' } };
  }
  const sy = rowY(child, childRow, compact), ty = rowY(parent, parentRow, compact);
  return parent.x + parent.w / 2 >= child.x + child.w / 2
    ? { source: { x: child.x + child.w, y: sy, side: 'right' }, target: { x: parent.x, y: ty, side: 'left' } }
    : { source: { x: child.x, y: sy, side: 'left' }, target: { x: parent.x + parent.w, y: ty, side: 'right' } };
}
