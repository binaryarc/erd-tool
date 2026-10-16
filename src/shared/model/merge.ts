// 리버스 결과를 기존 모델에 맞춘다: 같은 이름 테이블은 ID 를 유지하고, 무엇이 바뀌는지 목록을 만든다 (설계 6-1)

import { serializeModel } from './erd-format';
import type { SchemaModel, Table } from './types';

export interface ModelDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** 함수 이름(인자) */
  functionsAdded: string[];
  functionsRemoved: string[];
  functionsChanged: string[];
  sequencesChanged: boolean;
}

export const isEmptyDiff = (d: ModelDiff) =>
  !d.added.length && !d.removed.length && !d.changed.length
  && !d.functionsAdded.length && !d.functionsRemoved.length && !d.functionsChanged.length && !d.sequencesChanged;

/**
 * DB → ERD 골라 받기: names 에 든 테이블만 next(새로 읽은 DB) 것으로 바꾸고 나머지는 prev(지금 모델)를 그대로 둔다.
 * names 의 테이블이 next 에 없으면(없어진 테이블) 모델에서도 뺀다. 함수, 시퀀스는 takeRoutines 일 때만 next 것을 받는다.
 * next 는 mergeModel 을 거친 모델이라 ID 는 이미 prev 기준으로 맞춰져 있다.
 */
export function applySelected(prev: SchemaModel | null, next: SchemaModel, names: Set<string>, takeRoutines: boolean): SchemaModel {
  if (!prev) return next;
  const p = new Map(prev.tables.map(t => [t.name, t]));
  const n = new Map(next.tables.map(t => [t.name, t]));
  const tables: Table[] = [];
  for (const name of [...new Set([...p.keys(), ...n.keys()])].sort()) {
    const t = names.has(name) ? n.get(name) : p.get(name);
    if (t) tables.push(t);
  }
  return {
    ...next, tables,
    functions: takeRoutines ? next.functions : prev.functions,
    sequences: takeRoutines ? next.sequences : prev.sequences,
  };
}

/**
 * next 의 테이블 ID 를 prev 기준으로 다시 매긴다. next 의 ID 는 무시한다.
 * 도메인 (STEP 10): DB 는 컬럼이 어떤 도메인인지 모르므로 prev 의 「테이블.컬럼 → 도메인」 연결을 이어받는다.
 * DB 타입이 도메인 타입과 다르면 그 컬럼만 연결을 풀고 warnings 에 적는다. 연결이 풀린 테이블은 diff.changed 에 잡힌다 (결정 6)
 */
export function mergeModel(prev: SchemaModel | null, next: SchemaModel): { model: SchemaModel; diff: ModelDiff; warnings: string[] } {
  const prevByName = new Map((prev?.tables ?? []).map(t => [t.name, t]));
  let maxId = Math.max(0, ...(prev?.tables ?? []).map(t => Number(t.id.slice(1)) || 0));
  const domains = next.domains ?? prev?.domains;
  const domainType = new Map((domains ?? []).map(d => [d.name, d.type]));
  const warnings: string[] = [];
  const tables: Table[] = [...next.tables].sort((a, b) => (a.name < b.name ? -1 : 1)).map(t => {
    const old = prevByName.get(t.name);
    const oldCols = new Map((old?.columns ?? []).map(c => [c.name, c]));
    const columns = t.columns.map(c => {
      const d = oldCols.get(c.name)?.domain;
      if (d === undefined || c.domain !== undefined) return c;
      if (domainType.get(d) === c.type) return { ...c, domain: d };
      warnings.push(`${t.name}.${c.name}: DB 타입 ${c.type} 이 도메인 ${d} 의 타입 ${domainType.get(d) ?? '(도메인 없음)'} 과 달라 도메인 연결을 풀었다`);
      return c;
    });
    return { ...t, id: old ? old.id : 't' + ++maxId, columns };
  });
  const model: SchemaModel = { ...next, tables, ...(domains ? { domains } : {}) };

  // 같은 공통 컬럼, 그룹 규칙으로 직렬화해 테이블 단위 글자 비교
  const text = (m: SchemaModel, t: Table) => serializeModel({ ...m, tables: [t], functions: [], sequences: [] });
  const nextNames = new Set(tables.map(t => t.name));
  const fnKey = (f: { name: string; args: string }) => `${f.name}(${f.args})`;
  const prevFns = new Map((prev?.functions ?? []).map(f => [fnKey(f), f.definition]));
  const nextFns = new Map(model.functions.map(f => [fnKey(f), f.definition]));
  const seqText = (m: SchemaModel | null) => JSON.stringify([...(m?.sequences ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1)));

  const diff: ModelDiff = {
    added: tables.filter(t => !prevByName.has(t.name)).map(t => t.name),
    removed: [...prevByName.keys()].filter(n => !nextNames.has(n)).sort(),
    changed: prev
      ? tables.filter(t => prevByName.has(t.name) && JSON.stringify(text(model, t)) !== JSON.stringify(text(prev, prevByName.get(t.name)!))).map(t => t.name)
      : [],
    functionsAdded: [...nextFns.keys()].filter(k => !prevFns.has(k)).sort(),
    functionsRemoved: [...prevFns.keys()].filter(k => !nextFns.has(k)).sort(),
    functionsChanged: [...nextFns.keys()].filter(k => prevFns.has(k) && prevFns.get(k) !== nextFns.get(k)).sort(),
    sequencesChanged: prev ? seqText(prev) !== seqText(model) : model.sequences.length > 0,
  };
  return { model, diff, warnings };
}
