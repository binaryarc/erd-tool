// 두 모델의 차이 (설계 6-2). from = 지금 모습, to = 바꿀 모습. 이름으로 맞춘다(테이블 ID 는 쓰지 않는다: 두 DB 의 ID 는 서로 다르다).

import type { Column, ForeignKey, FunctionDef, Index, SchemaModel, Sequence, Table, Unique } from './types';

export type DiffKind = 'table' | 'column' | 'pk' | 'fk' | 'unique' | 'index' | 'sequence' | 'function';
export type DiffChange = 'add' | 'drop' | 'alter';

export interface DiffItem {
  kind: DiffKind;
  change: DiffChange;
  /** 테이블 이름 (테이블에 딸린 것) */
  table?: string;
  /** 대상 이름: 컬럼, 제약, 인덱스, 시퀀스, 함수 이름(인자) */
  name: string;
  /** 사람이 읽는 설명 */
  detail: string;
  /** 데이터가 사라지거나 적용이 실패할 수 있다 */
  danger?: string;
  from?: unknown;
  to?: unknown;
}

const byName = <T extends { name: string }>(xs: T[]) => new Map(xs.map(x => [x.name, x]));
const fnKey = (f: FunctionDef) => `${f.name}(${f.args})`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// 함수 정의는 DB 버전에 따라 공백 모양만 다를 수 있어 공백을 하나로 줄여 비교한다
const normDef = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 값이 잘리거나 바뀔 수 있는 타입 변경인가 */
export function narrowing(from: string, to: string): string | undefined {
  const p = (t: string) => {
    const m = t.match(/^([a-z ]+?)(?:\((\d+)(?:,\s*(\d+))?\))?(\[\])?$/i);
    return m ? { base: m[1].trim().toLowerCase(), a: m[2] ? Number(m[2]) : undefined, b: m[3] ? Number(m[3]) : undefined, arr: !!m[4] } : null;
  };
  const f = p(from), t = p(to);
  if (!f || !t) return `타입을 ${from} 에서 ${to} 로 바꾼다`;
  const widen: Record<string, string[]> = { smallint: ['integer', 'bigint', 'numeric'], integer: ['bigint', 'numeric'], bigint: ['numeric'], varchar: ['text'], char: ['varchar', 'text'], real: ['double precision'] };
  if (f.base === t.base && f.arr === t.arr) {
    if (f.a !== undefined && (t.a === undefined ? false : t.a < f.a)) return `길이를 ${f.a} 에서 ${t.a} 로 줄인다`;
    if (f.b !== undefined && t.b !== undefined && t.b < f.b) return `소수 자리를 ${f.b} 에서 ${t.b} 로 줄인다`;
    if (f.a === undefined && t.a !== undefined) return `길이 제한 ${t.a} 를 새로 둔다`;
    return undefined;
  }
  if (widen[f.base]?.includes(t.base) && f.arr === t.arr) {
    if (f.base === 'char' && t.base === 'varchar' && f.a !== undefined && t.a !== undefined && t.a < f.a) return `길이를 ${f.a} 에서 ${t.a} 로 줄인다`;
    return undefined;
  }
  return `타입을 ${from} 에서 ${to} 로 바꾼다 (값 변환이 실패할 수 있다)`;
}

function columnChanges(t: string, a: Column, b: Column): DiffItem | null {
  const parts: string[] = [];
  let danger: string | undefined;
  if (a.type !== b.type) { parts.push(`타입 ${a.type} → ${b.type}`); danger = narrowing(a.type, b.type); }
  if (a.notNull !== b.notNull) {
    parts.push(b.notNull ? 'NULL 허용 → NOT NULL' : 'NOT NULL → NULL 허용');
    if (b.notNull) danger = danger ?? 'NULL 인 행이 있으면 적용이 실패한다';
  }
  if ((a.default ?? null) !== (b.default ?? null)) parts.push(`기본값 ${a.default ?? '없음'} → ${b.default ?? '없음'}`);
  if ((a.comment ?? '') !== (b.comment ?? '')) parts.push('코멘트');
  if (!parts.length) return null;
  return { kind: 'column', change: 'alter', table: t, name: b.name, detail: parts.join(', '), danger, from: a, to: b };
}

function keyed<T extends { name: string }>(kind: DiffKind, table: string, from: T[], to: T[], describe: (x: T) => string): DiffItem[] {
  const out: DiffItem[] = [];
  const fa = byName(from), ta = byName(to);
  for (const [n, x] of fa) if (!ta.has(n)) out.push({ kind, change: 'drop', table, name: n, detail: describe(x), from: x });
  for (const [n, x] of ta) {
    const old = fa.get(n);
    if (!old) out.push({ kind, change: 'add', table, name: n, detail: describe(x), to: x });
    else if (!same(old, x)) out.push({ kind, change: 'alter', table, name: n, detail: `${describe(old)} → ${describe(x)}`, from: old, to: x });
  }
  return out;
}

const fkText = (f: ForeignKey) => `(${f.columns.join(', ')}) > ${f.refTable}(${f.refColumns.join(', ')})`;
const ukText = (u: Unique) => `(${u.columns.join(', ')})`;
const ixText = (i: Index) => `(${i.columns.join(', ')})${i.unique ? ' UNIQUE' : ''}`;

function tableDiff(a: Table, b: Table): DiffItem[] {
  const out: DiffItem[] = [];
  if (a.comment !== b.comment) out.push({ kind: 'table', change: 'alter', table: b.name, name: b.name, detail: '테이블 코멘트', from: a, to: b });
  const ac = byName(a.columns), bc = byName(b.columns);
  for (const c of a.columns) if (!bc.has(c.name)) out.push({ kind: 'column', change: 'drop', table: b.name, name: c.name, detail: c.type, danger: '컬럼 값이 사라진다', from: c });
  for (const c of b.columns) {
    const old = ac.get(c.name);
    if (!old) {
      const danger = c.notNull && c.default === undefined ? '행이 있으면 NOT NULL 컬럼 추가가 실패한다 (기본값 없음)' : undefined;
      out.push({ kind: 'column', change: 'add', table: b.name, name: c.name, detail: `${c.type}${c.notNull ? ' NOT NULL' : ''}${c.default !== undefined ? ' = ' + c.default : ''}`, danger, to: c });
    } else {
      const ch = columnChanges(b.name, old, c);
      if (ch) out.push(ch);
    }
  }
  if (!same(a.pk, b.pk)) out.push({ kind: 'pk', change: a.pk.length && b.pk.length ? 'alter' : b.pk.length ? 'add' : 'drop', table: b.name, name: 'PK', detail: `(${a.pk.join(', ')}) → (${b.pk.join(', ')})`, from: a.pk, to: b.pk });
  out.push(...keyed('fk', b.name, a.fks, b.fks, fkText), ...keyed('unique', b.name, a.uniques, b.uniques, ukText), ...keyed('index', b.name, a.indexes, b.indexes, ixText));
  return out;
}

export function diffModels(from: SchemaModel, to: SchemaModel): DiffItem[] {
  const out: DiffItem[] = [];
  const ft = byName(from.tables), tt = byName(to.tables);
  for (const [n, t] of ft) if (!tt.has(n)) out.push({ kind: 'table', change: 'drop', table: n, name: n, detail: `${t.columns.length}개 컬럼`, danger: '테이블과 데이터가 사라진다', from: t });
  for (const [n, t] of tt) {
    const old = ft.get(n);
    if (!old) out.push({ kind: 'table', change: 'add', table: n, name: n, detail: `${t.columns.length}개 컬럼`, to: t });
    else out.push(...tableDiff(old, t));
  }
  const seqText = (s: Sequence) => `start ${s.start} inc ${s.inc}`;
  out.push(...keyed('sequence', '', from.sequences, to.sequences, seqText).map(d => ({ ...d, table: undefined })));
  const ff = new Map(from.functions.map(f => [fnKey(f), f])), tf = new Map(to.functions.map(f => [fnKey(f), f]));
  for (const [k, f] of ff) if (!tf.has(k)) out.push({ kind: 'function', change: 'drop', name: k, detail: isProcedure(f) ? '프로시저' : '함수', danger: '함수를 지운다 (부르는 곳이 있으면 오류)', from: f });
  for (const [k, f] of tf) {
    const old = ff.get(k);
    if (!old) out.push({ kind: 'function', change: 'add', name: k, detail: isProcedure(f) ? '프로시저' : '함수', to: f });
    else if (normDef(old.definition) !== normDef(f.definition)) out.push({ kind: 'function', change: 'alter', name: k, detail: '정의가 다르다', from: old, to: f });
  }
  return out;
}

export const isProcedure = (f: FunctionDef) => /^\s*create\s+(or\s+replace\s+)?procedure\b/i.test(f.definition);

/** 종류, 변화별 개수 (요약 표용) */
export function summarize(items: DiffItem[]): Record<DiffKind, Record<DiffChange, number>> {
  const z = () => ({ add: 0, drop: 0, alter: 0 });
  const s = { table: z(), column: z(), pk: z(), fk: z(), unique: z(), index: z(), sequence: z(), function: z() };
  for (const i of items) s[i.kind][i.change]++;
  return s;
}
