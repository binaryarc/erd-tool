// 그룹 규칙과 공통 컬럼 정하기 (리버스 때 기존 모델이 없을 때 쓴다)

import { sameColumn } from './erd-format';
import type { Column, GroupRule, Table } from './types';

/** 그룹 규칙 파일 erd-groups.json ({ grp_rules: [{prefix, grp}], grp_default }) → 그룹 규칙 */
export function groupsFromErdGroupsJson(json: { grp_rules?: { prefix: string; grp: string }[]; grp_default?: string }): GroupRule[] {
  const rules: GroupRule[] = (json.grp_rules ?? []).map(r => ({ name: r.grp, prefix: r.prefix }));
  const def = json.grp_default;
  if (def) {
    const g = rules.find(r => r.name === def);
    if (g) g.isDefault = true;
    else rules.push({ name: def, isDefault: true });
  }
  return rules.length ? rules : [{ name: 'main', isDefault: true }];
}

/** 접두어 목록(예: mst_, whs_) → 그룹 규칙. 그룹 이름은 끝의 _ 를 뗀 접두어, 어디에도 안 맞는 테이블은 기본 그룹 etc */
export function groupsFromPrefixes(prefixes: string[]): GroupRule[] {
  const rules: GroupRule[] = [];
  for (const p of prefixes.map(x => x.trim()).filter(Boolean)) {
    if (!/^\w+$/.test(p)) throw new Error(`접두어는 영문, 숫자, _ 로 입력하세요: ${p}`);
    const name = p.replace(/_+$/, '') || p;
    if (!rules.some(r => r.prefix === p || r.name === name)) rules.push({ name, prefix: p });
  }
  const def = rules.some(r => r.name === 'etc') ? 'etc_default' : 'etc';
  return [...rules, { name: def, isDefault: true }];
}

/**
 * 테이블 끝 컬럼 묶음 중 가장 많이 겹치는 것을 공통 컬럼으로 고른다.
 * 묶음 길이 2~6, minTables 개 이상 테이블에 똑같이(이름, 타입, NULL, 기본값, 코멘트) 있어야 한다.
 * 줄어드는 줄 수(테이블 수 × 묶음 길이)가 가장 큰 것을 고른다.
 */
export function detectCommon(tables: Table[], minTables = 10): Column[] {
  let best: { cols: Column[]; score: number } = { cols: [], score: 0 };
  for (let k = 2; k <= 6; k++) {
    const counts = new Map<string, { cols: Column[]; n: number }>();
    for (const t of tables) {
      if (t.columns.length <= k) continue;
      const tail = t.columns.slice(t.columns.length - k);
      const key = JSON.stringify(tail.map(c => [c.name, c.type, c.notNull, c.default ?? null, c.comment ?? '']));
      const e = counts.get(key) ?? { cols: tail, n: 0 };
      e.n++;
      counts.set(key, e);
    }
    for (const { cols, n } of counts.values()) {
      if (n >= minTables && n * k > best.score) best = { cols: cols.map(c => ({ ...c })), score: n * k };
    }
  }
  return best.cols;
}

export const sameColumns = (a: Column[], b: Column[]) => a.length === b.length && a.every((c, i) => sameColumn(c, b[i]));
