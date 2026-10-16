// AI 에게 주는 글 (STEP 8, 설계 10-2, 10-3). 전체 모델을 한 번에 주지 않고 개요 → 필요한 테이블 순서로 묻게 한다.
// 좌표 숫자 대신 그룹 규칙과 행, 열 위치로 화면 배치를 알린다(AI 가 좌표를 계산하면 격자가 어긋난다).

import { columnText, endsWithCommon, groupOf } from '../model/erd-format';
import { arrangeMode, type Diagram } from '../model/layout';
import type { SchemaModel, Table } from '../model/types';

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 그룹마다 한 줄: 그룹 이름, 접두어, 테이블 수, 테이블 이름들. 공통 컬럼 정의도 한 줄 */
export function overview(model: SchemaModel): string {
  const fks = model.tables.reduce((n, t) => n + t.fks.length, 0);
  const lines = [`테이블 ${model.tables.length}, FK ${fks}, 그룹 ${model.groups.length}. 자세한 구조는 erd_tables 로 필요한 테이블만 묻는다`];
  if (model.common.length) lines.push(`+common = ${model.common.map(c => columnText(c, false)).join(', ')}`);
  for (const g of model.groups) {
    const names = model.tables.filter(t => groupOf(t.name, model.groups) === g.name).sort(byName).map(t => t.name);
    if (names.length) lines.push(`${g.name}${g.prefix ? ` (${g.prefix})` : ' (기본)'} ${names.length}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

/** 테이블 한 개를 설계 10-2 표기로. 단일 컬럼 FK 는 컬럼 뒤 FK>테이블.컬럼, 여러 컬럼 FK 는 따로 한 줄 */
export function tableText(model: SchemaModel, t: Table): string {
  const collapse = endsWithCommon(t.columns, model.common);
  const cols = collapse ? t.columns.slice(0, t.columns.length - model.common.length) : t.columns;
  const singlePk = t.pk.length === 1 ? t.pk[0] : undefined;
  const inlineFk = new Map<string, string>();
  for (const f of t.fks) if (f.columns.length === 1) inlineFk.set(f.columns[0], `${inlineFk.has(f.columns[0]) ? inlineFk.get(f.columns[0]) + ' ' : ''}FK>${f.refTable}.${f.refColumns[0]}`);
  const group = groupOf(t.name, model.groups);
  return [
    [t.name, `[${group}]`, t.comment, collapse ? '+common' : ''].filter(Boolean).join(' '),
    ...cols.map(c => {
      const base = columnText(c, c.name === singlePk);
      const fk = inlineFk.get(c.name);
      if (!fk) return '  ' + base;
      const hash = base.indexOf(' #'); // FK 표시는 코멘트 앞에
      return '  ' + (hash >= 0 ? `${base.slice(0, hash)} ${fk}${base.slice(hash)}` : `${base} ${fk}`);
    }),
    ...(t.pk.length > 1 ? [`  PK (${t.pk.join(', ')})`] : []),
    ...t.fks.filter(f => f.columns.length > 1).map(f => `  FK ${f.name} (${f.columns.join(', ')}) > ${f.refTable}(${f.refColumns.join(', ')})`),
    ...t.uniques.map(u => `  UQ ${u.name} (${u.columns.join(', ')})`),
    ...t.indexes.map(i => `  IX ${i.name} (${i.columns.join(', ')})${i.unique ? ' UNIQUE' : ''}`),
  ].join('\n');
}

export function tablesText(model: SchemaModel, names: string[]): string {
  const out: string[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const t = model.tables.find(x => x.name === n);
    if (t) out.push(tableText(model, t)); else missing.push(n);
  }
  if (missing.length) out.push(`없는 테이블: ${missing.join(', ')}`);
  return out.join('\n');
}

export interface Box { x: number; y: number; w: number; h: number }

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** b 가 a 의 어느 쪽에 있는지 (가운데 기준) */
function side(a: Box, b: Box): string {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2), dy = b.y + b.h / 2 - (a.y + a.h / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? '오른쪽' : '왼쪽') : (dy > 0 ? '아래' : '위');
}

/** 화면 배치를 말로 (설계 10-3). boxes 는 테이블 ID 별 화면 사각형 */
export function viewStateText(model: SchemaModel, d: Diagram, boxes: Map<string, Box>, zoom: number, diagramName: string): string {
  const name = new Map(model.tables.map(t => [t.id, t.name]));
  const tree = arrangeMode(d) === 'tree';
  const lines = [`다이어그램 ${diagramName}: ${tree ? '트리 배치 (FK 부모가 위, 자식이 아래)' : '그룹 격자 배치'}, 확대 ${Math.round(zoom * 100)}%`];
  if (!tree) {
    for (const [g, p] of Object.entries(d.groups).sort(([, a], [, b]) => a.rule.origin[0] - b.rule.origin[0])) {
      lines.push(`그룹 ${g}: 격자 ${p.rule.cols}열 간격 ${p.rule.gap}`);
      for (let i = 0; i < p.order.length; i += p.rule.cols) {
        const row = p.order.slice(i, i + p.rule.cols).map(id => `${name.get(id) ?? id}${d.pinned[id] ? '(고정됨)' : ''}`);
        lines.push(`  ${i / p.rule.cols + 1}행: ${row.join(', ')}`);
      }
    }
  }
  // 끌어 옮긴(고정한) 테이블은 가장 가까운 테이블 기준으로 말한다
  for (const id of Object.keys(d.pinned)) {
    const me = boxes.get(id);
    if (!me) continue;
    let best: { id: string; dist: number } | undefined;
    for (const [oid, b] of boxes) {
      if (oid === id) continue;
      const dist = Math.hypot(b.x + b.w / 2 - (me.x + me.w / 2), b.y + b.h / 2 - (me.y + me.h / 2));
      if (!best || dist < best.dist) best = { id: oid, dist };
    }
    lines.push(`고정: ${name.get(id)}${best ? ` (${name.get(best.id)} 의 ${side(boxes.get(best.id)!, me)})` : ''}`);
  }
  const ids = [...boxes.keys()];
  let pairs = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (overlaps(boxes.get(ids[i])!, boxes.get(ids[j])!)) pairs++;
  lines.push(`겹친 테이블 쌍: ${pairs}`);
  return lines.join('\n');
}
