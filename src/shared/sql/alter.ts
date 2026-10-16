// 차이 → PostgreSQL ALTER 스크립트 (설계 6-2). from 을 to 처럼 바꾼다.
// 순서: 지울 FK, UNIQUE, 인덱스 → 지울 테이블 → 새 시퀀스 → 컬럼 변경, 추가, 삭제와 PK → 새 테이블 → 코멘트
//       → 새 UNIQUE, 인덱스, FK → 지울 시퀀스 → 함수
// 만든 SQL 은 바로 실행하지 않고 SQL 탭에 띄운다. 위험한 문장 위에는 [위험] 주석을 단다.
// flyway 선택 사항(STEP 7): 허브 03-flyway-migration.md 4절대로 public. 을 붙이고 여러 번 실행해도 안전하게 쓴다
//   (IF NOT EXISTS, IF EXISTS, 제약 추가는 pg_constraint 를 확인하는 DO 블록).

import { diffModels, isProcedure, type DiffItem } from '../model/diff';
import type { Check, Column, ForeignKey, FunctionDef, Index, SchemaModel, Sequence, Table, Unique } from '../model/types';

const RESERVED = new Set(['user', 'order', 'group', 'table', 'select', 'from', 'where', 'desc', 'asc', 'limit', 'offset', 'check', 'default', 'primary', 'references', 'column', 'end', 'type', 'key']);
/** 식별자: 소문자, 숫자, _ 이고 예약어가 아니면 그대로, 아니면 큰따옴표 */
export const q = (n: string) => (/^[a-z_][a-z0-9_]*$/.test(n) && !RESERVED.has(n) ? n : `"${n.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const cols = (xs: string[]) => xs.map(x => (/^[a-z_][a-z0-9_]*$/i.test(x) ? q(x) : x)).join(', '); // 식 인덱스는 그대로

const identityClause = (i: NonNullable<Column['identity']>) => `GENERATED ${i === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;

/** 컬럼 정의. 생성 컬럼은 DEFAULT 대신 생성식, identity 는 IDENTITY 절 (2026-10-16: 전에는 생성식을 DEFAULT 로 써서 PostgreSQL 이 거부했다) */
function colDef(c: Column): string {
  return [
    q(c.name), c.type, c.notNull ? 'NOT NULL' : '',
    c.generated !== undefined ? `GENERATED ALWAYS AS (${c.generated}) STORED` : c.default !== undefined ? `DEFAULT ${c.default}` : '',
    c.identity ? identityClause(c.identity) : '',
  ].filter(Boolean).join(' ');
}

export interface AlterOptions {
  /** Flyway 파일용: public. 접두어와 여러 번 실행해도 안전한 문장 */
  flyway?: boolean;
}

/** 문장 만들기. flyway 면 이름에 public. 을 붙이고 IF NOT EXISTS, IF EXISTS 를 쓴다 */
function writer(o: AlterOptions) {
  const f = !!o.flyway;
  const n = (x: string) => (f ? 'public.' + q(x) : q(x));
  const ifNot = f ? 'IF NOT EXISTS ' : '';
  const ifEx = f ? 'IF EXISTS ' : '';
  /** flyway 면 제약이 없을 때만 실행 (ADD CONSTRAINT 에는 IF NOT EXISTS 가 없다) */
  const guard = (t: string, sql: string, cond: string) => (f
    ? `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ${lit(n(t))}::regclass AND ${cond}) THEN ${sql} END IF; END $$;`
    : sql);
  return {
    n,
    createTable: (t: Table) => [
      `CREATE TABLE ${ifNot}${n(t.name)} (`,
      [...t.columns.map(c => '  ' + colDef(c)), ...(t.pk.length ? [`  PRIMARY KEY (${cols(t.pk)})`] : [])].join(',\n'),
      ');',
    ].join('\n'),
    comments: (t: Table) => [
      ...(t.comment ? [`COMMENT ON TABLE ${n(t.name)} IS ${lit(t.comment)};`] : []),
      ...t.columns.filter(c => c.comment).map(c => `COMMENT ON COLUMN ${n(t.name)}.${q(c.name)} IS ${lit(c.comment!)};`),
    ],
    addFk: (t: string, k: ForeignKey) => guard(t,
      `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(k.name)} FOREIGN KEY (${cols(k.columns)}) REFERENCES ${n(k.refTable)} (${cols(k.refColumns)});`,
      `conname = ${lit(k.name)}`),
    addUq: (t: string, u: Unique) => guard(t, `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(u.name)} UNIQUE (${cols(u.columns)});`, `conname = ${lit(u.name)}`),
    addCk: (t: string, c: Check) => guard(t, `ALTER TABLE ${n(t)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`, `conname = ${lit(c.name)}`),
    /** flyway 면 옛 이름이 있을 때만 (여러 번 실행해도 안전) */
    renameTable: (from: string, to: string) => `ALTER TABLE ${ifEx}${n(from)} RENAME TO ${q(to)};`,
    renameColumn: (t: string, from: string, to: string) => (f
      ? `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${lit(t)} AND column_name = ${lit(from)}) THEN ALTER TABLE ${n(t)} RENAME COLUMN ${q(from)} TO ${q(to)}; END IF; END $$;`
      : `ALTER TABLE ${n(t)} RENAME COLUMN ${q(from)} TO ${q(to)};`),
    addPk: (t: string, pk: string[]) => guard(t, `ALTER TABLE ${n(t)} ADD PRIMARY KEY (${cols(pk)});`, `contype = 'p'`),
    addIx: (t: string, i: Index) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${ifNot}${q(i.name)} ON ${n(t)} (${cols(i.columns)});`,
    dropIx: (i: string) => `DROP INDEX ${ifEx}${n(i)};`,
    dropCon: (t: string, c: string) => `ALTER TABLE ${n(t)} DROP CONSTRAINT ${ifEx}${q(c)};`,
    dropTable: (t: string) => `DROP TABLE ${ifEx}${n(t)};`,
    addColumn: (t: string, c: Column) => `ALTER TABLE ${n(t)} ADD COLUMN ${ifNot}${colDef(c)};`,
    dropColumn: (t: string, c: string) => `ALTER TABLE ${n(t)} DROP COLUMN ${ifEx}${q(c)};`,
    createSeq: (s: Sequence) => `CREATE SEQUENCE ${ifNot}${n(s.name)} START WITH ${s.start} INCREMENT BY ${s.inc};`,
    dropSeq: (s: string) => `DROP SEQUENCE ${ifEx}${n(s)};`,
    /** PK 제약 이름은 모델에 없어(단일 PK 는 컬럼 줄 표시뿐) DB 에서 찾아 지운다 */
    dropPk: (t: string) => [
      `DO $$`,
      `DECLARE n text;`,
      `BEGIN`,
      `  SELECT conname INTO n FROM pg_constraint WHERE conrelid = ${lit(n(t))}::regclass AND contype = 'p';`,
      `  IF n IS NOT NULL THEN EXECUTE format('ALTER TABLE ${f ? 'public.' : ''}%I DROP CONSTRAINT %I', ${lit(t)}, n); END IF;`,
      `END $$;`,
    ].join('\n'),
    fnSql: (fn: FunctionDef) => fn.definition.replace(/;?\s*$/, '') + ';',
    dropFn: (fn: FunctionDef) => `DROP ${isProcedure(fn) ? 'PROCEDURE' : 'FUNCTION'} ${ifEx}${n(fn.name)}(${fn.args});`,
  };
}

export interface AlterScript { sql: string; statements: number; dangers: number; items: DiffItem[] }

export function buildAlter(from: SchemaModel, to: SchemaModel, items: DiffItem[] = diffModels(from, to), opts: AlterOptions = {}): AlterScript {
  const w = writer(opts);
  const toTables = new Map(to.tables.map(t => [t.name, t]));
  const sections: { title: string; lines: string[] }[] = [];
  let dangers = 0;
  const section = (title: string) => { const s = { title, lines: [] as string[] }; sections.push(s); return s.lines; };
  const warn = (lines: string[], d?: string) => { if (d) { lines.push(`-- [위험] ${d}`); dangers++; } };

  const isTableAdd = (t?: string) => items.some(i => i.kind === 'table' && i.change === 'add' && i.name === t);
  const isTableDrop = (t?: string) => items.some(i => i.kind === 'table' && i.change === 'drop' && i.name === t);

  // 0) 이름 바꾸기를 맨 먼저: 아래 문장은 모두 새 이름을 쓴다. 테이블을 먼저 바꾸고 컬럼은 새 테이블 이름으로 바꾼다
  //    (전에는 이름 바꾸기가 삭제와 추가로 나와 데이터가 사라질 수 있었다, 2026-10-16 화면 재현)
  const renames = section('이름 바꾸기');
  for (const i of items.filter(x => x.change === 'rename' && x.kind === 'table')) renames.push(w.renameTable(i.from as string, i.to as string));
  for (const i of items.filter(x => x.change === 'rename' && x.kind === 'column')) renames.push(w.renameColumn(i.table!, i.from as string, i.to as string));

  // 1) 지울 FK, UNIQUE, CHECK, 인덱스 (바뀌는 것은 지우고 다시 만든다). 지울 테이블에 딸린 것은 테이블과 함께 사라진다
  const dropKeys = section('지울 FK, UNIQUE, CHECK, 인덱스');
  for (const i of items) {
    if (!['fk', 'unique', 'check', 'index'].includes(i.kind) || i.change === 'add' || isTableDrop(i.table)) continue;
    dropKeys.push(i.kind === 'index' ? w.dropIx(i.name) : w.dropCon(i.table!, i.name));
  }

  // 2) 지울 테이블
  const dropTables = section('지울 테이블');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'drop')) { warn(dropTables, `${i.name}: ${i.danger}`); dropTables.push(w.dropTable(i.name)); }

  // 3) 새 시퀀스 (새 테이블 기본값 nextval 이 먼저 필요)
  const seqAdd = section('새 시퀀스, 바뀐 시퀀스');
  for (const i of items.filter(x => x.kind === 'sequence' && x.change !== 'drop')) {
    const s = i.to as Sequence;
    seqAdd.push(i.change === 'add' ? w.createSeq(s)
      : `ALTER SEQUENCE ${w.n(s.name)} INCREMENT BY ${s.inc}; -- 시작값은 바꾸지 않는다 (지금 값 ${s.start})`);
  }

  // 4) 있는 테이블의 컬럼과 PK.
  //    PK 는 먼저 지우고 컬럼을 바꾼 뒤 다시 만든다: PK 에 든 컬럼은 NOT NULL 을 풀 수 없다 (dev 실제 적용 시험에서 확인)
  const pkDrops = section('바뀌는 PK 지우기');
  for (const i of items) {
    if (i.kind === 'pk' && i.change !== 'add' && !isTableAdd(i.table) && !isTableDrop(i.table)) pkDrops.push(w.dropPk(i.table!));
  }
  const colLines = section('컬럼 변경, 추가, 삭제');
  for (const i of items) {
    if (isTableAdd(i.table) || isTableDrop(i.table) || i.kind === 'pk') continue;
    const t = w.n(i.table ?? '');
    if (i.kind === 'column' && i.change === 'add') {
      warn(colLines, i.danger && `${i.table}.${i.name}: ${i.danger}`);
      colLines.push(w.addColumn(i.table!, i.to as Column));
    } else if (i.kind === 'column' && i.change === 'drop') {
      warn(colLines, `${i.table}.${i.name}: ${i.danger}`);
      colLines.push(w.dropColumn(i.table!, i.name));
    } else if (i.kind === 'column' && i.change === 'alter') {
      const a = i.from as Column, b = i.to as Column, c = q(b.name);
      warn(colLines, i.danger && `${i.table}.${i.name}: ${i.danger}`);
      // 생성식을 새로 두거나 바꾸는 것은 ALTER 로 안 되어 컬럼을 지우고 다시 만든다 (다른 속성도 새 정의로 함께 들어간다)
      if (a.generated !== b.generated && b.generated !== undefined) {
        colLines.push(w.dropColumn(i.table!, b.name), w.addColumn(i.table!, b));
        if (b.comment) colLines.push(`COMMENT ON COLUMN ${t}.${c} IS ${lit(b.comment)};`);
        continue;
      }
      if (a.generated !== undefined && b.generated === undefined) colLines.push(`ALTER TABLE ${t} ALTER COLUMN ${c} DROP EXPRESSION;`);
      // identity 를 없애는 것은 기본값을 두기 전에, 새로 두는 것은 NOT NULL 뒤에 (기본값이 있으면 identity 를 둘 수 없다)
      if (a.identity && !b.identity) colLines.push(`ALTER TABLE ${t} ALTER COLUMN ${c} DROP IDENTITY IF EXISTS;`);
      if (a.type !== b.type) colLines.push(`ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${b.type} USING ${c}::${b.type};`);
      if ((a.default ?? null) !== (b.default ?? null)) colLines.push(b.default !== undefined ? `ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${b.default};` : `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT;`);
      if (a.notNull !== b.notNull) colLines.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ${b.notNull ? 'SET' : 'DROP'} NOT NULL;`);
      if (!a.identity && b.identity) colLines.push(`ALTER TABLE ${t} ALTER COLUMN ${c} ADD ${identityClause(b.identity)};`);
      if (a.identity && b.identity && a.identity !== b.identity) colLines.push(`ALTER TABLE ${t} ALTER COLUMN ${c} SET GENERATED ${b.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'};`);
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
    if (pk.length) pkAdds.push(w.addPk(i.table!, pk));
  }

  // 5) 새 테이블 (FK 는 7 에서 한꺼번에: 서로 참조하는 새 테이블이 있어도 순서 걱정이 없다)
  const newTables = section('새 테이블');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    newTables.push(w.createTable(t), ...w.comments(t));
  }

  // 6) UNIQUE, CHECK, 인덱스 추가 (새 테이블 것 포함)
  const addKeys = section('새 UNIQUE, CHECK, 인덱스');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    addKeys.push(...t.uniques.map(u => w.addUq(t.name, u)), ...(t.checks ?? []).map(k => w.addCk(t.name, k)), ...t.indexes.map(x => w.addIx(t.name, x)));
  }
  for (const i of items) {
    if (i.change === 'drop' || i.change === 'rename' || isTableAdd(i.table)) continue;
    if (i.kind === 'unique') addKeys.push(w.addUq(i.table!, i.to as Unique));
    if (i.kind === 'check') addKeys.push(w.addCk(i.table!, i.to as Check));
    if (i.kind === 'index') addKeys.push(w.addIx(i.table!, i.to as Index));
  }

  // 7) FK 추가
  const addFks = section('새 FK');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    addFks.push(...t.fks.map(f => w.addFk(t.name, f)));
  }
  for (const i of items) if (i.kind === 'fk' && i.change !== 'drop' && !isTableAdd(i.table)) addFks.push(w.addFk(i.table!, i.to as ForeignKey));

  // 8) 지울 시퀀스 (테이블 기본값이 더는 쓰지 않을 때)
  const seqDrop = section('지울 시퀀스');
  for (const i of items.filter(x => x.kind === 'sequence' && x.change === 'drop')) seqDrop.push(w.dropSeq(i.name));

  // 9) 함수
  const fns = section('함수');
  for (const i of items.filter(x => x.kind === 'function')) {
    if (i.change === 'drop') { warn(fns, `${i.name}: ${i.danger}`); fns.push(w.dropFn(i.from as FunctionDef)); }
    else fns.push(w.fnSql(i.to as FunctionDef));
  }

  const body = sections.filter(s => s.lines.length).map(s => `-- ${s.title}\n${s.lines.join('\n')}`).join('\n\n');
  const statements = sections.reduce((n, s) => n + s.lines.filter(l => !l.startsWith('--') && /;\s*$/.test(l.split('\n').at(-1)!)).length, 0);
  const head = `-- ERD 도구가 만든 ALTER (${items.length}개 차이, 위험 ${dangers}개). 바로 실행하지 말고 확인 뒤 실행한다\n`;
  return { sql: items.length ? head + '\n' + body + '\n' : '-- 차이가 없다\n', statements, dangers, items };
}
