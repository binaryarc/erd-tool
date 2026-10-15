// 테이블 노드 폭 계산: 보기 모드에 따라 보이는 글자 폭을 실제로 재서 정한다 (TableNode.vue 의 CSS 와 같은 글꼴, 여백)
import { NODE } from '../../shared/model/arrange';
import type { Table } from '../../shared/model/types';
import type { NameMode } from './view';

const FONT = "11px Consolas, 'Malgun Gothic', monospace";
const BOLD = 'bold ' + FONT;
const ctx = document.createElement('canvas').getContext('2d')!;
const cache = new Map<string, number>();

function measure(text: string, font = FONT): number {
  const key = font + '\u0000' + text;
  let w = cache.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    cache.set(key, w);
  }
  return w;
}

// TableNode.vue: 좌우 여백 6, 칸 사이 6, 키 칸 26, 테두리 1+1
const PAD = 12, GAP = 6, KEY = 26, BORDER = 2;

export function tableWidth(t: Table, mode: NameMode): number {
  const title = mode === 'logical' ? t.comment || t.name : t.name;
  let head = PAD + measure(title, BOLD);
  if (mode === 'both' && t.comment) head += GAP + measure(t.comment);
  let body = 0;
  for (const c of t.columns) {
    const name = mode === 'logical' ? c.comment || c.name : c.name;
    let w = PAD + KEY + GAP + measure(name, c.notNull ? BOLD : FONT) + GAP + measure(c.type);
    if (mode === 'both' && c.comment) w += GAP + measure(c.comment);
    body = Math.max(body, w);
  }
  return Math.ceil(Math.min(NODE.maxWidth, Math.max(NODE.width, head, body) + BORDER + 4));
}
