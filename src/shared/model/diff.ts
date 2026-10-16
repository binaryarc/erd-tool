// 두 모델의 차이 (설계 6-2). from = 지금 모습, to = 바꿀 모습. 이름으로 맞춘다(테이블 ID 는 쓰지 않는다: 두 DB 의 ID 는 서로 다르다).

import { updateColumn, updateTable } from './edit';
import { fkOptions } from './erd-format';
import type { Check, Column, ForeignKey, FunctionDef, Index, SchemaModel, Sequence, Table, Unique } from './types';

export type DiffKind = 'table' | 'column' | 'pk' | 'fk' | 'unique' | 'check' | 'index' | 'sequence' | 'function';
/** rename: 테이블, 컬럼 이름 바꾸기 (화면에서 바꾼 기록 renamedFrom 이 있을 때만. from 은 옛 이름, to 는 새 이름) */
export type DiffChange = 'add' | 'drop' | 'alter' | 'rename';

/** 화면, AI 글, Flyway 머리 주석이 같이 쓰는 이름표 */
export const DIFF_KIND_LABEL: Record<DiffKind, string> = { table: '테이블', column: '컬럼', pk: 'PK', fk: 'FK', unique: 'UNIQUE', check: 'CHECK', index: '인덱스', sequence: '시퀀스', function: '함수' };
export const DIFF_CHANGE_LABEL: Record<DiffChange, string> = { add: '추가', drop: '삭제', alter: '변경', rename: '이름 바꿈' };

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
  if (a.identity !== b.identity) parts.push(`IDENTITY ${a.identity ?? '없음'} → ${b.identity ?? '없음'}`);
  if (a.generated !== b.generated) {
    parts.push(`생성식 ${a.generated ?? '없음'} → ${b.generated ?? '없음'}`);
    // 생성식을 새로 두거나 바꾸려면 컬럼을 지우고 다시 만든다 (생성식을 없애는 것은 값을 남기는 DROP EXPRESSION)
    if (b.generated !== undefined) danger = '생성식을 두거나 바꾸려면 컬럼을 지우고 다시 만든다 (값은 생성식으로 다시 계산된다)';
  }
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

const fkText = (f: ForeignKey) => `(${f.columns.join(', ')}) > ${f.refTable}(${f.refColumns.join(', ')})${fkOptions(f)}`;
const ukText = (u: Unique) => `(${u.columns.join(', ')})`;
const ixText = (i: Index) => `(${i.columns.join(', ')})${i.unique ? ' UNIQUE' : ''}`;
const ckText = (c: Check) => c.definition;

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
  out.push(...keyed('fk', b.name, a.fks, b.fks, fkText), ...keyed('unique', b.name, a.uniques, b.uniques, ukText),
    ...keyed('check', b.name, a.checks ?? [], b.checks ?? [], ckText), ...keyed('index', b.name, a.indexes, b.indexes, ixText));
  return out;
}

interface Rename { kind: 'table' | 'column'; table: string; old: string; to: string }

/**
 * 화면에서 바꾼 이름(renamedFrom)으로 찾은 이름 바꾸기. 두 방향 다 본다: to 에 기록이 있으면 옛 이름 → 새 이름,
 * from 에 기록이 있으면(Flyway 롤백처럼 거꾸로 비교) 새 이름 → 옛 이름. 옛 이름이 상대 쪽에 실제로 있고 새 이름은 없을 때만 바꾸기로 본다.
 * 기록은 파일에 저장하지 않아, 저장하고 다시 연 모델은 예전처럼 삭제와 추가로 나온다.
 */
function findRenames(from: SchemaModel, to: SchemaModel): Rename[] {
  const out: Rename[] = [];
  const fNames = new Set(from.tables.map(t => t.name)), tNames = new Set(to.tables.map(t => t.name));
  const tableTo = new Map<string, string>(); // from 의 테이블 이름 → to 의 테이블 이름
  for (const t of to.tables) {
    const r = t.renamedFrom;
    if (r && fNames.has(r) && !fNames.has(t.name) && !tNames.has(r)) { out.push({ kind: 'table', table: t.name, old: r, to: t.name }); tableTo.set(r, t.name); }
  }
  for (const t of from.tables) {
    const r = t.renamedFrom;
    if (r && tNames.has(r) && !tNames.has(t.name) && !fNames.has(r)) { out.push({ kind: 'table', table: r, old: t.name, to: r }); tableTo.set(t.name, r); }
  }
  for (const a of from.tables) {
    const b = to.tables.find(x => x.name === (tableTo.get(a.name) ?? a.name));
    if (!b) continue;
    const ac = new Set(a.columns.map(c => c.name)), bc = new Set(b.columns.map(c => c.name));
    for (const c of b.columns) {
      const r = c.renamedFrom;
      if (r && ac.has(r) && !ac.has(c.name) && !bc.has(r)) out.push({ kind: 'column', table: b.name, old: r, to: c.name });
    }
    for (const c of a.columns) {
      const r = c.renamedFrom;
      if (r && bc.has(r) && !bc.has(c.name) && !ac.has(r)) out.push({ kind: 'column', table: b.name, old: c.name, to: r });
    }
  }
  return out;
}

export function diffModels(from0: SchemaModel, to: SchemaModel): DiffItem[] {
  // 이름 바꾸기를 먼저 from 에 적용해 두면 나머지 차이(타입, 키 등)는 새 이름으로 맞춰 비교된다.
  // 바꾸기는 edit.ts 를 써서 PK, FK, UNIQUE, 인덱스, 다른 테이블 FK 참조도 함께 새 이름이 된다(PostgreSQL RENAME 과 같다)
  const renames = findRenames(from0, to);
  let from = from0;
  const out: DiffItem[] = [];
  for (const r of renames) {
    if (r.kind === 'table') from = updateTable(from, r.old, { name: r.to });
    else from = updateColumn(from, r.table, r.old, { name: r.to });
    out.push({ kind: r.kind, change: 'rename', table: r.table, name: r.to, detail: `${r.old} → ${r.to}`, from: r.old, to: r.to });
  }
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
  const z = () => ({ add: 0, drop: 0, alter: 0, rename: 0 });
  const s = { table: z(), column: z(), pk: z(), fk: z(), unique: z(), check: z(), index: z(), sequence: z(), function: z() };
  for (const i of items) s[i.kind][i.change]++;
  return s;
}
