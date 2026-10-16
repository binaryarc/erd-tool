// ERD 수정 명령 (STEP 6). 모델을 직접 고치지 않고 새 모델을 돌려준다(되돌리기는 이전 모델을 들고 있으면 된다).
// 이름 바꾸기와 삭제는 그 이름을 가리키는 곳(PK, FK, UNIQUE, 인덱스, 다른 테이블의 FK)을 함께 고친다.
// 잘못된 명령은 EditError 를 던지고 모델은 그대로다.

import { shortType } from './pg-types';
import type { Column, ForeignKey, SchemaModel, Table } from './types';

export class EditError extends Error {}

const fail = (msg: string): never => { throw new EditError(msg); };

/** 사람이 친 타입을 리버스가 돌려주는 모양으로 맞춘다. 다르면 DB 에 적용하고 다시 읽을 때 차이로 나온다 */
const TYPE_INPUT: Record<string, string> = {
  int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint', bool: 'boolean',
  float8: 'double precision', float4: 'real', serial: 'integer', bigserial: 'bigint',
};
export function normalizeType(input: string): string {
  const t = shortType(input.trim().replace(/\s+/g, ' ').toLowerCase()).replace(/\s*\(\s*/, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/, ')');
  return TYPE_INPUT[t] ?? t;
}

function table(m: SchemaModel, name: string): Table {
  return m.tables.find(t => t.name === name) ?? fail(`테이블 ${name} 이 없다`);
}

function checkName(kind: string, name: string) {
  if (!name.trim()) fail(`${kind} 이름이 비었다`);
  if (/\s/.test(name)) fail(`${kind} 이름 ${name} 에 공백이 있다`);
}

/** 테이블 하나를 바꾼 새 모델 */
const withTable = (m: SchemaModel, name: string, f: (t: Table) => Table): SchemaModel =>
  ({ ...m, tables: m.tables.map(t => (t.name === name ? f(t) : t)) });

export function nextTableId(m: SchemaModel): string {
  return 't' + (Math.max(0, ...m.tables.map(t => Number(t.id.slice(1)) || 0)) + 1);
}

// ---------- 테이블 ----------

export function addTable(m: SchemaModel, name: string, opts: { comment?: string; withCommon?: boolean } = {}): SchemaModel {
  checkName('테이블', name);
  if (m.tables.some(t => t.name === name)) fail(`테이블 ${name} 이 이미 있다`);
  const t: Table = {
    id: nextTableId(m), name, comment: opts.comment ?? '', columns: opts.withCommon ? m.common.map(c => ({ ...c })) : [],
    pk: [], fks: [], uniques: [], indexes: [],
  };
  return { ...m, tables: [...m.tables, t] };
}

/** 이름, 코멘트 바꾸기. 이름을 바꾸면 다른 테이블의 FK 참조도 바꾼다(ID 는 그대로라 화면 배치가 유지된다) */
export function updateTable(m: SchemaModel, name: string, patch: { name?: string; comment?: string }): SchemaModel {
  table(m, name);
  const to = patch.name ?? name;
  if (to !== name) {
    checkName('테이블', to);
    if (m.tables.some(t => t.name === to)) fail(`테이블 ${to} 이 이미 있다`);
  }
  return {
    ...m,
    tables: m.tables.map(t => ({
      ...(t.name === name ? withRenamed({ ...t, name: to, comment: patch.comment ?? t.comment }, t.renamedFrom ?? name) : t),
      fks: t.fks.map(f => (f.refTable === name ? { ...f, refTable: to } : f)),
    })),
  };
}

/** 바꾸기 전 이름을 기억한다(차이 계산이 RENAME 을 만든다). 원래 이름으로 되돌아오면 기록을 지운다 */
function withRenamed<T extends { name: string; renamedFrom?: string }>(x: T, original: string): T {
  const { renamedFrom: _old, ...rest } = x;
  return (original === x.name ? rest : { ...rest, renamedFrom: original }) as T;
}

/** 식(CHECK, 생성식) 안에 컬럼 이름이 낱말로 들어 있는가 */
const mentions = (expr: string, col: string) => new RegExp(`(^|[^\\w"])"?${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?($|[^\\w"])`).test(expr);
/** 식 안의 컬럼 이름을 바꾼다 (PostgreSQL 은 이름을 바꾸면 CHECK, 생성식도 따라 바꾼다) */
const renameIn = (expr: string, from: string, to: string) =>
  expr.replace(new RegExp(`(^|[^\\w"])("?)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2(?=$|[^\\w"])`, 'g'), (_m, pre, qt) => `${pre}${qt}${to}${qt}`);

/** 테이블을 지우면 그 테이블을 가리키는 다른 테이블의 FK 도 지운다 */
export function dropTable(m: SchemaModel, name: string): SchemaModel {
  table(m, name);
  return {
    ...m,
    tables: m.tables.filter(t => t.name !== name).map(t => ({ ...t, fks: t.fks.filter(f => f.refTable !== name) })),
  };
}

// ---------- 컬럼 ----------

export interface ColumnInput extends Column {
  pk?: boolean;
}

/** after 를 주면 그 컬럼 뒤에, 없으면 공통 컬럼(+common) 앞에 넣는다. 공통 컬럼이 끝에 모여 있어야 +common 으로 줄여 저장된다 */
export function addColumn(m: SchemaModel, tableName: string, input: ColumnInput, after?: string): SchemaModel {
  const t = table(m, tableName);
  checkName('컬럼', input.name);
  if (t.columns.some(c => c.name === input.name)) fail(`${tableName} 에 컬럼 ${input.name} 이 이미 있다`);
  const { pk, ...rest } = input;
  const col: Column = clean({ ...rest, type: normalizeType(rest.type), notNull: rest.notNull || !!pk });
  if (!col.type) fail('타입이 비었다');
  let at = t.columns.length;
  if (after !== undefined) at = t.columns.findIndex(c => c.name === after) + 1 || fail(`${tableName} 에 컬럼 ${after} 이 없다`);
  else at = commonStart(m, t);
  return withTable(m, tableName, x => ({
    ...x, columns: [...x.columns.slice(0, at), col, ...x.columns.slice(at)], pk: pk ? [...x.pk, col.name] : x.pk,
  }));
}

/** 테이블 끝에 공통 컬럼이 정의 순서대로 모두 있으면 그 시작 위치, 아니면 끝 */
function commonStart(m: SchemaModel, t: Table): number {
  const n = m.common.length;
  if (!n || t.columns.length < n) return t.columns.length;
  const tail = t.columns.slice(-n);
  return tail.every((c, i) => c.name === m.common[i].name) ? t.columns.length - n : t.columns.length;
}

/** 빈 기본값, 빈 코멘트는 없는 것으로 (모델에 undefined 로 둬야 저장, 비교가 같다) */
function clean(c: Column): Column {
  const out: Column = { name: c.name, type: c.type, notNull: c.notNull };
  if (c.default !== undefined && c.default.trim() !== '') out.default = c.default.trim();
  if (c.comment !== undefined && c.comment !== '') out.comment = c.comment;
  if (c.identity) out.identity = c.identity;
  if (c.generated !== undefined) out.generated = c.generated;
  if (c.renamedFrom !== undefined) out.renamedFrom = c.renamedFrom;
  return out;
}

/** 컬럼 고치기. 이름을 바꾸면 이 테이블의 PK, FK, UNIQUE, 인덱스와 다른 테이블의 FK 참조 컬럼도 바꾼다.
 *  pk 를 켜면 NOT NULL 도 켠다(PostgreSQL 이 PK 컬럼을 NOT NULL 로 만든다) */
export function updateColumn(m: SchemaModel, tableName: string, colName: string, patch: Partial<ColumnInput>): SchemaModel {
  const t = table(m, tableName);
  const old = t.columns.find(c => c.name === colName) ?? fail(`${tableName} 에 컬럼 ${colName} 이 없다`);
  const to = patch.name ?? colName;
  if (to !== colName) {
    checkName('컬럼', to);
    if (t.columns.some(c => c.name === to)) fail(`${tableName} 에 컬럼 ${to} 이 이미 있다`);
  }
  const isPk = patch.pk ?? t.pk.includes(colName);
  const { pk: _pk, ...rest } = patch;
  const merged: Column = { ...old, ...rest, name: to };
  if (rest.type !== undefined) merged.type = normalizeType(rest.type) || fail('타입이 비었다');
  if (isPk) merged.notNull = true;
  const col = clean(to === colName ? merged : withRenamed(merged, old.renamedFrom ?? colName));
  const ren = (xs: string[]) => xs.map(x => (x === colName ? to : x));
  const renExpr = (s: string) => (to === colName ? s : renameIn(s, colName, to));
  let pk = ren(t.pk);
  if (isPk && !pk.includes(to)) pk = [...pk, to];
  if (!isPk) pk = pk.filter(x => x !== to);
  return {
    ...m,
    tables: m.tables.map(x => {
      const refFix = (f: ForeignKey) => (f.refTable === tableName ? { ...f, refColumns: ren(f.refColumns) } : f);
      if (x.name !== tableName) return to === colName ? x : { ...x, fks: x.fks.map(refFix) };
      return {
        ...x, pk,
        columns: x.columns.map(c => (c.name === colName ? col : c.generated !== undefined ? { ...c, generated: renExpr(c.generated) } : c)),
        fks: x.fks.map(f => refFix({ ...f, columns: ren(f.columns) })),
        uniques: x.uniques.map(u => ({ ...u, columns: ren(u.columns) })),
        indexes: x.indexes.map(i => ({ ...i, columns: ren(i.columns) })),
        ...(x.checks ? { checks: x.checks.map(k => ({ ...k, definition: renExpr(k.definition) })) } : {}),
      };
    }),
  };
}

/** 컬럼을 지우면 그 컬럼이 든 FK, UNIQUE, 인덱스와 그 컬럼을 참조하는 다른 테이블의 FK 도 지운다(PostgreSQL 의 DROP COLUMN 과 같다) */
export function dropColumn(m: SchemaModel, tableName: string, colName: string): SchemaModel {
  const t = table(m, tableName);
  if (!t.columns.some(c => c.name === colName)) fail(`${tableName} 에 컬럼 ${colName} 이 없다`);
  return {
    ...m,
    tables: m.tables.map(x => {
      const keep = (f: ForeignKey) => !(f.refTable === tableName && f.refColumns.includes(colName));
      if (x.name !== tableName) return { ...x, fks: x.fks.filter(keep) };
      return {
        ...x,
        columns: x.columns.filter(c => c.name !== colName),
        pk: x.pk.includes(colName) ? [] : x.pk, // 복합 PK 에서 하나를 빼면 PostgreSQL 은 PK 를 통째로 지운다
        fks: x.fks.filter(f => keep(f) && !f.columns.includes(colName)),
        uniques: x.uniques.filter(u => !u.columns.includes(colName)),
        indexes: x.indexes.filter(i => !i.columns.includes(colName)),
        // 그 컬럼을 쓰는 CHECK 도 PostgreSQL 이 함께 지운다
        ...(x.checks ? { checks: x.checks.filter(k => !mentions(k.definition, colName)) } : {}),
      };
    }),
  };
}

/** 컬럼 순서 바꾸기 (delta: -1 위로, 1 아래로). 화면과 CREATE 문의 순서만 바뀐다 */
export function moveColumn(m: SchemaModel, tableName: string, colName: string, delta: -1 | 1): SchemaModel {
  const t = table(m, tableName);
  const i = t.columns.findIndex(c => c.name === colName);
  if (i < 0) fail(`${tableName} 에 컬럼 ${colName} 이 없다`);
  const j = i + delta;
  if (j < 0 || j >= t.columns.length) return m;
  const columns = [...t.columns];
  [columns[i], columns[j]] = [columns[j], columns[i]];
  return withTable(m, tableName, x => ({ ...x, columns }));
}

// ---------- FK ----------

export const defaultFkName = (m: SchemaModel, tableName: string, refTable: string): string => {
  const taken = new Set(m.tables.flatMap(t => t.fks.map(f => f.name)));
  const base = `fk_${tableName}_${refTable}`;
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
  return n;
};

export function addFk(m: SchemaModel, tableName: string, fk: ForeignKey): SchemaModel {
  const t = table(m, tableName);
  checkName('FK', fk.name);
  if (m.tables.some(x => x.fks.some(f => f.name === fk.name))) fail(`FK 이름 ${fk.name} 이 이미 있다`);
  if (!fk.columns.length) fail('FK 컬럼을 고르세요');
  if (fk.columns.length !== fk.refColumns.length) fail('FK 컬럼 수와 참조 컬럼 수가 다르다');
  for (const c of fk.columns) if (!t.columns.some(x => x.name === c)) fail(`${tableName} 에 컬럼 ${c} 이 없다`);
  const ref = table(m, fk.refTable);
  for (const c of fk.refColumns) if (!ref.columns.some(x => x.name === c)) fail(`${fk.refTable} 에 컬럼 ${c} 이 없다`);
  // PostgreSQL 은 참조 컬럼이 PK 나 UNIQUE 여야 FK 를 만든다
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));
  const keyed = sameSet(ref.pk, fk.refColumns) || ref.uniques.some(u => sameSet(u.columns, fk.refColumns))
    || ref.indexes.some(i => i.unique && sameSet(i.columns, fk.refColumns));
  if (!keyed) fail(`${fk.refTable}(${fk.refColumns.join(', ')}) 가 PK 나 UNIQUE 가 아니라 FK 로 가리킬 수 없다`);
  const cleanFk: ForeignKey = { name: fk.name, columns: [...fk.columns], refTable: fk.refTable, refColumns: [...fk.refColumns] };
  return withTable(m, tableName, x => ({ ...x, fks: [...x.fks, cleanFk] }));
}

export function dropFk(m: SchemaModel, tableName: string, fkName: string): SchemaModel {
  const t = table(m, tableName);
  if (!t.fks.some(f => f.name === fkName)) fail(`${tableName} 에 FK ${fkName} 이 없다`);
  return withTable(m, tableName, x => ({ ...x, fks: x.fks.filter(f => f.name !== fkName) }));
}

// ---------- 되돌리기 ----------

/** 모델을 바꾸지 않고 통째로 들고 있어 되돌리기가 단순하다 (모델은 수정할 때마다 새로 만들어진다) */
export class EditHistory {
  private past: SchemaModel[] = [];
  private future: SchemaModel[] = [];
  constructor(private readonly limit = 200) {}

  /** 수정 직전 모델을 넣는다 */
  push(before: SchemaModel) {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: SchemaModel): SchemaModel | undefined {
    const prev = this.past.pop();
    if (prev) this.future.push(current);
    return prev;
  }
  redo(current: SchemaModel): SchemaModel | undefined {
    const next = this.future.pop();
    if (next) this.past.push(current);
    return next;
  }
  clear() { this.past = []; this.future = []; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}
