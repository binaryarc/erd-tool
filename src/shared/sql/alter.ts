// 차이 → PostgreSQL ALTER 스크립트 (설계 6-2). from 을 to 처럼 바꾼다.
// 순서: 지울 FK, UNIQUE, 인덱스 → 지울 테이블 → 새 시퀀스 → 컬럼 변경, 추가, 삭제와 PK → 새 테이블 → 코멘트
//       → 새 UNIQUE, 인덱스, FK → 지울 시퀀스 → 함수
// 만든 SQL 은 바로 실행하지 않고 SQL 탭에 띄운다. 위험한 문장 위에는 [위험] 주석을 단다.

import { diffModels, isProcedure, type DiffItem } from '../model/diff';
import type { Column, ForeignKey, FunctionDef, Index, SchemaModel, Sequence, Table, Unique } from '../model/types';

const RESERVED = new Set(['user', 'order', 'group', 'table', 'select', 'from', 'where', 'desc', 'asc', 'limit', 'offset', 'check', 'default', 'primary', 'references', 'column', 'end', 'type', 'key']);
/** 식별자: 소문자, 숫자, _ 이고 예약어가 아니면 그대로, 아니면 큰따옴표 */
export const q = (n: string) => (/^[a-z_][a-z0-9_]*$/.test(n) && !RESERVED.has(n) ? n : `"${n.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const cols = (xs: string[]) => xs.map(x => (/^[a-z_][a-z0-9_]*$/i.test(x) ? q(x) : x)).join(', '); // 식 인덱스는 그대로

function colDef(c: Column): string {
  return [q(c.name), c.type, c.notNull ? 'NOT NULL' : '', c.default !== undefined ? `DEFAULT ${c.default}` : ''].filter(Boolean).join(' ');
}

const createTable = (t: Table) => [
  `CREATE TABLE ${q(t.name)} (`,
  [...t.columns.map(c => '  ' + colDef(c)), ...(t.pk.length ? [`  PRIMARY KEY (${cols(t.pk)})`] : [])].join(',\n'),
  ');',
].join('\n');

const comments = (t: Table) => [
  ...(t.comment ? [`COMMENT ON TABLE ${q(t.name)} IS ${lit(t.comment)};`] : []),
  ...t.columns.filter(c => c.comment).map(c => `COMMENT ON COLUMN ${q(t.name)}.${q(c.name)} IS ${lit(c.comment!)};`),
];

const addFk = (t: string, f: ForeignKey) =>
  `ALTER TABLE ${q(t)} ADD CONSTRAINT ${q(f.name)} FOREIGN KEY (${cols(f.columns)}) REFERENCES ${q(f.refTable)} (${cols(f.refColumns)});`;
const addUq = (t: string, u: Unique) => `ALTER TABLE ${q(t)} ADD CONSTRAINT ${q(u.name)} UNIQUE (${cols(u.columns)});`;
const addIx = (t: string, i: Index) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(t)} (${cols(i.columns)});`;
const dropCon = (t: string, n: string) => `ALTER TABLE ${q(t)} DROP CONSTRAINT ${q(n)};`;

/** PK 제약 이름은 모델에 없어(단일 PK 는 컬럼 줄 표시뿐) DB 에서 찾아 지운다 */
const dropPk = (t: string) => [
  `DO $$`,
  `DECLARE n text;`,
  `BEGIN`,
  `  SELECT conname INTO n FROM pg_constraint WHERE conrelid = ${lit(t)}::regclass AND contype = 'p';`,
  `  IF n IS NOT NULL THEN EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', ${lit(t)}, n); END IF;`,
  `END $$;`,
].join('\n');

const fnSql = (f: FunctionDef) => f.definition.replace(/;?\s*$/, '') + ';';
const dropFn = (f: FunctionDef) => `DROP ${isProcedure(f) ? 'PROCEDURE' : 'FUNCTION'} ${q(f.name)}(${f.args});`;

export interface AlterScript { sql: string; statements: number; dangers: number; items: DiffItem[] }

export function buildAlter(from: SchemaModel, to: SchemaModel, items: DiffItem[] = diffModels(from, to)): AlterScript {
  const toTables = new Map(to.tables.map(t => [t.name, t]));
  const sections: { title: string; lines: string[] }[] = [];
  let dangers = 0;
  const section = (title: string) => { const s = { title, lines: [] as string[] }; sections.push(s); return s.lines; };
  const warn = (lines: string[], d?: string) => { if (d) { lines.push(`-- [위험] ${d}`); dangers++; } };

  const isTableAdd = (t?: string) => items.some(i => i.kind === 'table' && i.change === 'add' && i.name === t);
  const isTableDrop = (t?: string) => items.some(i => i.kind === 'table' && i.change === 'drop' && i.name === t);

  // 1) 지울 FK, UNIQUE, 인덱스 (바뀌는 것은 지우고 다시 만든다). 지울 테이블에 딸린 것은 테이블과 함께 사라진다
  const dropKeys = section('지울 FK, UNIQUE, 인덱스');
  for (const i of items) {
    if (!['fk', 'unique', 'index'].includes(i.kind) || i.change === 'add' || isTableDrop(i.table)) continue;
    dropKeys.push(i.kind === 'index' ? `DROP INDEX ${q(i.name)};` : dropCon(i.table!, i.name));
  }

  // 2) 지울 테이블
  const dropTables = section('지울 테이블');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'drop')) { warn(dropTables, `${i.name}: ${i.danger}`); dropTables.push(`DROP TABLE ${q(i.name)};`); }

  // 3) 새 시퀀스 (새 테이블 기본값 nextval 이 먼저 필요)
  const seqAdd = section('새 시퀀스, 바뀐 시퀀스');
  for (const i of items.filter(x => x.kind === 'sequence' && x.change !== 'drop')) {
    const s = i.to as Sequence;
    seqAdd.push(i.change === 'add' ? `CREATE SEQUENCE ${q(s.name)} START WITH ${s.start} INCREMENT BY ${s.inc};`
      : `ALTER SEQUENCE ${q(s.name)} INCREMENT BY ${s.inc}; -- 시작값은 바꾸지 않는다 (지금 값 ${s.start})`);
  }

  // 4) 있는 테이블의 컬럼과 PK.
  //    PK 는 먼저 지우고 컬럼을 바꾼 뒤 다시 만든다: PK 에 든 컬럼은 NOT NULL 을 풀 수 없다 (dev 실제 적용 시험에서 확인)
  const pkDrops = section('바뀌는 PK 지우기');
  for (const i of items) {
    if (i.kind === 'pk' && i.change !== 'add' && !isTableAdd(i.table) && !isTableDrop(i.table)) pkDrops.push(dropPk(i.table!));
  }
  const colLines = section('컬럼 변경, 추가, 삭제');
  for (const i of items) {
    if (isTableAdd(i.table) || isTableDrop(i.table) || i.kind === 'pk') continue;
    const t = q(i.table ?? '');
    if (i.kind === 'column' && i.change === 'add') {
      warn(colLines, i.danger && `${i.table}.${i.name}: ${i.danger}`);
      colLines.push(`ALTER TABLE ${t} ADD COLUMN ${colDef(i.to as Column)};`);
    } else if (i.kind === 'column' && i.change === 'drop') {
      warn(colLines, `${i.table}.${i.name}: ${i.danger}`);
      colLines.push(`ALTER TABLE ${t} DROP COLUMN ${q(i.name)};`);
    } else if (i.kind === 'column' && i.change === 'alter') {
      const a = i.from as Column, b = i.to as Column, c = q(b.name);
      warn(colLines, i.danger && `${i.table}.${i.name}: ${i.danger}`);
      if (a.type !== b.type) colLines.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${b.type} USING ${c}::${b.type};`);
      if ((a.default ?? null) !== (b.default ?? null)) colLines.push(b.default !== undefined ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${b.default};` : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`);
      if (a.notNull !== b.notNull) colLines.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${b.notNull ? 'SET' : 'DROP'} NOT NULL;`);
      if ((a.comment ?? '') !== (b.comment ?? '')) colLines.push(`COMMENT ON COLUMN ${t}.${c} IS ${b.comment ? lit(b.comment) : 'NULL'};`);
    } else if (i.kind === 'table' && i.change === 'alter') {
      const tb = i.to as Table;
      colLines.push(`COMMENT ON TABLE ${t} IS ${tb.comment ? lit(tb.comment) : 'NULL'};`);
    }
  }
  const pkAdds = section('바뀐 PK 만들기');
  for (const i of items) {
    if (i.kind !== 'pk' || isTableAdd(i.table) || isTableDrop(i.table)) continue;
    const pk = i.to as string[];
    if (pk.length) pkAdds.push(`ALTER TABLE ${q(i.table!)} ADD PRIMARY KEY (${cols(pk)});`);
  }

  // 5) 새 테이블 (FK 는 7 에서 한꺼번에: 서로 참조하는 새 테이블이 있어도 순서 걱정이 없다)
  const newTables = section('새 테이블');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    newTables.push(createTable(t), ...comments(t));
  }

  // 6) UNIQUE, 인덱스 추가 (새 테이블 것 포함)
  const addKeys = section('새 UNIQUE, 인덱스');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    addKeys.push(...t.uniques.map(u => addUq(t.name, u)), ...t.indexes.map(x => addIx(t.name, x)));
  }
  for (const i of items) {
    if (i.change === 'drop' || isTableAdd(i.table)) continue;
    if (i.kind === 'unique') addKeys.push(addUq(i.table!, i.to as Unique));
    if (i.kind === 'index') addKeys.push(addIx(i.table!, i.to as Index));
  }

  // 7) FK 추가
  const addFks = section('새 FK');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    addFks.push(...t.fks.map(f => addFk(t.name, f)));
  }
  for (const i of items) if (i.kind === 'fk' && i.change !== 'drop' && !isTableAdd(i.table)) addFks.push(addFk(i.table!, i.to as ForeignKey));

  // 8) 지울 시퀀스 (테이블 기본값이 더는 쓰지 않을 때)
  const seqDrop = section('지울 시퀀스');
  for (const i of items.filter(x => x.kind === 'sequence' && x.change === 'drop')) seqDrop.push(`DROP SEQUENCE ${q(i.name)};`);

  // 9) 함수
  const fns = section('함수');
  for (const i of items.filter(x => x.kind === 'function')) {
    if (i.change === 'drop') { warn(fns, `${i.name}: ${i.danger}`); fns.push(dropFn(i.from as FunctionDef)); }
    else fns.push(fnSql(i.to as FunctionDef));
  }

  const body = sections.filter(s => s.lines.length).map(s => `-- ${s.title}\n${s.lines.join('\n')}`).join('\n\n');
  const statements = sections.reduce((n, s) => n + s.lines.filter(l => !l.startsWith('--') && /;\s*$/.test(l.split('\n').at(-1)!)).length, 0);
  const head = `-- ERD 도구가 만든 ALTER (${items.length}개 차이, 위험 ${dangers}개). 바로 실행하지 말고 확인 뒤 실행한다\n`;
  return { sql: items.length ? head + '\n' + body + '\n' : '-- 차이가 없다\n', statements, dangers, items };
}
