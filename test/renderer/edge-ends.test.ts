import { describe, expect, it } from 'vitest';
import { edgeEnds, rowY } from '../../src/renderer/src/edge-ends';

// 폭 200, 높이 100 테이블. 자식은 (0, 300) 에 둔다
const child = { x: 0, y: 300, w: 200, h: 100 };
const at = (x: number, y: number) => ({ x, y, w: 200, h: 100 });

describe('FK 선 끝 고르기', () => {
  it('부모가 바로 위에 있으면 자식 위쪽에서 나가 부모 아래쪽으로 들어간다', () => {
    const { source, target } = edgeEnds(child, at(30, 0), 2, 0, false);
    expect(source).toEqual({ x: 100, y: 300, side: 'top' });
    expect(target).toEqual({ x: 130, y: 100, side: 'bottom' });
  });

  it('부모가 바로 아래에 있으면 자식 아래쪽에서 나가 부모 위쪽으로 들어간다', () => {
    const { source, target } = edgeEnds(child, at(-30, 600), 2, 0, false);
    expect(source.side).toBe('bottom');
    expect(target.side).toBe('top');
    expect(source.y).toBe(400);
    expect(target.y).toBe(600);
  });

  it('부모가 왼쪽에 있으면 자식 왼쪽에서 나가 부모 오른쪽으로 들어가고, 높이는 FK 컬럼 줄 가운데다', () => {
    const { source, target } = edgeEnds(child, at(-500, 280), 2, 0, false);
    expect(source).toEqual({ x: 0, y: 300 + 1 + 24 + 2 * 18 + 9, side: 'left' });
    expect(target).toEqual({ x: -300, y: 280 + 1 + 24 + 9, side: 'right' });
  });

  it('부모가 오른쪽에 있으면 전처럼 자식 오른쪽에서 나가 부모 왼쪽으로 들어간다', () => {
    const { source, target } = edgeEnds(child, at(500, 320), 0, 1, false);
    expect(source.side).toBe('right');
    expect(target.side).toBe('left');
    expect(source.x).toBe(200);
    expect(target.x).toBe(500);
  });

  it('위아래 틈보다 좌우 틈이 크면 옆면으로 잇는다 (멀리 떨어진 대각선)', () => {
    expect(edgeEnds(child, at(800, 0), 0, 0, false).source.side).toBe('right');
    expect(edgeEnds(child, at(300, -400), 0, 0, false).source.side).toBe('top');
  });

  it('축소 보기이거나 컬럼을 못 찾으면 옆면 높이는 테이블 머리 가운데다', () => {
    expect(rowY(child, 5, true)).toBe(312);
    expect(rowY(child, -1, false)).toBe(313);
  });
});
