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

/** next 의 테이블 ID 를 prev 기준으로 다시 매긴다. next 의 ID 는 무시한다 */
export function mergeModel(prev: SchemaModel | null, next: SchemaModel): { model: SchemaModel; diff: ModelDiff } {
  const prevByName = new Map((prev?.tables ?? []).map(t => [t.name, t]));
  let maxId = Math.max(0, ...(prev?.tables ?? []).map(t => Number(t.id.slice(1)) || 0));
  const tables: Table[] = [...next.tables].sort((a, b) => (a.name < b.name ? -1 : 1)).map(t => {
    const old = prevByName.get(t.name);
    return { ...t, id: old ? old.id : 't' + ++maxId };
  });
  const model: SchemaModel = { ...next, tables };

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
  return { model, diff };
}
