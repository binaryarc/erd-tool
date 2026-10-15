// ERD 에서 고른 테이블들을 FK 경로로 이어 SELECT 를 만든다 (설계 9장 4번)
// 첫 테이블에서 시작해 FK(양방향)를 너비 우선으로 따라가며, 고른 테이블에 닿는 가장 짧은 경로를 붙인다.
// 경로 중간 테이블도 JOIN 에 들어간다. 이어지지 않는 테이블은 주석으로 알린다.

import type { SchemaModel } from '../model/types';

interface Edge { from: string; to: string; on: [string, string][] }

function edges(model: SchemaModel): Map<string, Edge[]> {
  const g = new Map<string, Edge[]>();
  const add = (e: Edge) => g.set(e.from, [...(g.get(e.from) ?? []), e]);
  for (const t of model.tables) {
    for (const f of t.fks) {
      const on = f.columns.map((c, i) => [c, f.refColumns[i]] as [string, string]);
      add({ from: t.name, to: f.refTable, on });
      add({ from: f.refTable, to: t.name, on: on.map(([a, b]) => [b, a]) });
    }
  }
  return g;
}

/** 테이블 별칭: 이름 마지막 단어 첫 글자들 (mst_biz_wh → bw), 겹치면 숫자 */
function aliasFor(name: string, used: Set<string>): string {
  const parts = name.split('_');
  const base = (parts.length > 1 ? parts.slice(1) : parts).map(p => p[0]).join('') || 't';
  let a = base, n = 2;
  while (used.has(a)) a = base + n++;
  used.add(a);
  return a;
}

export function buildJoinSelect(model: SchemaModel, picked: string[]): string {
  const names = [...new Set(picked)].filter(n => model.tables.some(t => t.name === n));
  if (!names.length) return '';
  const g = edges(model);
  const used = new Set<string>();
  const alias = new Map<string, string>();
  const order: { table: string; via?: Edge }[] = [{ table: names[0] }];
  alias.set(names[0], aliasFor(names[0], used));
  const missing: string[] = [];

  for (const target of names.slice(1)) {
    if (alias.has(target)) continue;
    // 이미 들어간 테이블 전체에서 target 까지 너비 우선 탐색
    const prev = new Map<string, Edge | null>([...alias.keys()].map(k => [k, null]));
    const queue = [...alias.keys()];
    while (queue.length && !prev.has(target)) {
      const cur = queue.shift()!;
      for (const e of g.get(cur) ?? []) if (!prev.has(e.to)) { prev.set(e.to, e); queue.push(e.to); }
    }
    if (!prev.has(target)) { missing.push(target); continue; }
    const path: Edge[] = [];
    for (let e = prev.get(target); e; e = prev.get(e.from) ?? null) path.unshift(e);
    for (const e of path) {
      if (alias.has(e.to)) continue;
      alias.set(e.to, aliasFor(e.to, used));
      order.push({ table: e.to, via: e });
    }
  }

  const lines = [
    'SELECT ' + order.map(o => `${alias.get(o.table)}.*`).join(', '),
    `  FROM ${order[0].table} ${alias.get(order[0].table)}`,
    ...order.slice(1).map(({ table, via }) =>
      `  JOIN ${table} ${alias.get(table)} ON ` +
      via!.on.map(([a, b]) => `${alias.get(table)}.${b} = ${alias.get(via!.from)}.${a}`).join(' AND ')),
  ];
  if (missing.length) lines.push(`-- FK 로 이어지지 않아 뺀 테이블: ${missing.join(', ')}`);
  return lines.join('\n') + '\nLIMIT 100;';
}
