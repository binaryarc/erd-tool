// 모델 형식 검증 — 문법은 parseModel 이, 의미(중복, 없는 대상)는 여기서 본다

import type { ParseResult } from './erd-format';
import type { ModelError } from './types';

const ID_RE = /^t\d+$/;

export function validateModel({ model, errors: parseErrors, where }: ParseResult): ModelError[] {
  const errors: ModelError[] = [...parseErrors];
  const at = (key: string, message: string) => {
    const w = where.get(key) ?? { file: '?', line: 0 };
    errors.push({ ...w, message });
  };

  const byName = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const t of model.tables) {
    byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
    if (!ID_RE.test(t.id)) at(t.name, `${t.name}: ID 형식이 t숫자가 아닙니다 (@${t.id})`);
    const other = ids.get(t.id);
    if (other) at(t.name, `${t.name}: ID @${t.id} 가 ${other} 와(과) 겹칩니다`);
    else ids.set(t.id, t.name);
  }
  for (const [name, n] of byName) if (n > 1) at(name, `테이블 이름 ${name} 이 ${n}번 나옵니다`);

  // 도메인 (STEP 10): 이름이 겹치지 않고, 연결한 컬럼은 있는 도메인을 가리키며 타입이 같다
  const domains = new Map<string, string>();
  for (const d of model.domains ?? []) {
    if (domains.has(d.name)) errors.push({ file: '_index.erd', line: 0, message: `도메인 ${d.name} 이 두 번 나옵니다` });
    domains.set(d.name, d.type);
  }
  const tables = new Map(model.tables.map(t => [t.name, t]));
  for (const t of model.tables) {
    const cols = new Set<string>();
    for (const c of t.columns) {
      if (cols.has(c.name)) at(t.name, `${t.name}: 컬럼 ${c.name} 이 두 번 나옵니다`);
      cols.add(c.name);
      if (c.domain === undefined) continue;
      const dt = domains.get(c.domain);
      if (dt === undefined) at(t.name, `${t.name}: 컬럼 ${c.name} 의 도메인 ${c.domain} 이(가) 없습니다`);
      else if (dt !== c.type) at(t.name, `${t.name}: 컬럼 ${c.name} 의 타입 ${c.type} 이 도메인 ${c.domain} 의 타입 ${dt} 와(과) 다릅니다`);
    }
    for (const p of t.pk) if (!cols.has(p)) at(t.name, `${t.name}: PK 컬럼 ${p} 이(가) 없습니다`);
    for (const u of t.uniques) {
      for (const c of u.columns) if (!cols.has(c)) at(t.name, `${t.name}: UNIQUE ${u.name} 의 컬럼 ${c} 이(가) 없습니다`);
    }
    for (const ix of t.indexes) {
      for (const c of ix.columns) {
        if (/^\w+$/.test(c) && !cols.has(c)) at(t.name, `${t.name}: 인덱스 ${ix.name} 의 컬럼 ${c} 이(가) 없습니다`);
      }
    }
    for (const f of t.fks) {
      const key = `${t.name} ${f.name}`;
      for (const c of f.columns) if (!cols.has(c)) at(key, `${t.name}: FK ${f.name} 의 컬럼 ${c} 이(가) 없습니다`);
      if (f.columns.length !== f.refColumns.length) at(key, `${t.name}: FK ${f.name} 의 컬럼 수와 참조 컬럼 수가 다릅니다`);
      const ref = tables.get(f.refTable);
      if (!ref) { at(key, `${t.name}: FK ${f.name} 의 참조 테이블 ${f.refTable} 이(가) 없습니다`); continue; }
      const refCols = new Set(ref.columns.map(c => c.name));
      for (const c of f.refColumns) if (!refCols.has(c)) at(key, `${t.name}: FK ${f.name} 의 참조 컬럼 ${f.refTable}.${c} 이(가) 없습니다`);
    }
  }
  return errors;
}
