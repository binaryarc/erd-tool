// 차이 → ALTER 스크립트 (설계 6-2). from 을 to 처럼 바꾼다.
// 순서: 지울 FK, UNIQUE, 인덱스 → 지울 테이블 → 새 시퀀스 → 컬럼 변경, 추가, 삭제와 PK → 새 테이블 → 코멘트
//       → 새 UNIQUE, 인덱스, FK → 지울 시퀀스 → 함수
// 만든 SQL 은 바로 실행하지 않고 SQL 탭에 띄운다. 위험한 문장 위에는 [위험] 주석을 단다.
// 문장 모양은 DB 종류별 DDL 작성기(shared/dialect/)가 만든다. DB 종류는 from(적용할 DB)을 따른다.

import { diffModels, type DiffItem } from '../model/diff';
import { dialectOf, rulesFor, type DdlOptions, type DdlWriter } from '../dialect';
import type { Check, Column, ForeignKey, FunctionDef, Index, SchemaModel, Sequence, Table, Unique } from '../model/types';

export type AlterOptions = DdlOptions;

export interface AlterScript { sql: string; statements: number; dangers: number; items: DiffItem[] }

// 구간 함수가 같이 쓰는 값. section 은 부른 순서대로 구간을 쌓으므로 구간 함수를 부르는 순서가 곧 문장 순서다
interface AlterContext {
  w: DdlWriter;
  items: DiffItem[];
  fromTables: Map<string, Table>;
  toTables: Map<string, Table>;
  section: (title: string) => string[];
  warn: (lines: string[], d?: string) => void;
  isTableAdd: (t?: string) => boolean;
  isTableDrop: (t?: string) => boolean;
}

export function buildAlter(from: SchemaModel, to: SchemaModel, items: DiffItem[] = diffModels(from, to), opts: AlterOptions = {}): AlterScript {
  const at = from.dialect ? from : to;
  const sections: { title: string; lines: string[] }[] = [];
  let dangers = 0;
  const c: AlterContext = {
    w: rulesFor(dialectOf(at)).ddl({ schema: at.schema, ...opts }),
    items,
    fromTables: new Map(from.tables.map(t => [t.name, t])),
    toTables: new Map(to.tables.map(t => [t.name, t])),
    section: title => { const s = { title, lines: [] as string[] }; sections.push(s); return s.lines; },
    warn: (lines, d) => { if (d) { lines.push(`-- [위험] ${d}`); dangers++; } },
    isTableAdd: t => items.some(i => i.kind === 'table' && i.change === 'add' && i.name === t),
    isTableDrop: t => items.some(i => i.kind === 'table' && i.change === 'drop' && i.name === t),
  };

  renames(c);
  dropKeys(c);
  dropTables(c);
  addSequences(c);
  columnsAndPk(c);
  newTables(c);
  addKeys(c);
  addFks(c);
  dropSequences(c);
  functions(c);

  const body = sections.filter(s => s.lines.length).map(s => `-- ${s.title}\n${s.lines.join('\n')}`).join('\n\n');
  const statements = sections.reduce((n, s) => n + s.lines.filter(l => !l.startsWith('--') && /;\s*$/.test(l.split('\n').at(-1)!)).length, 0);
  const head = `-- ERD 도구가 만든 ALTER (${items.length}개 차이, 위험 ${dangers}개). 바로 실행하지 말고 확인 뒤 실행한다\n`;
  return { sql: items.length ? head + '\n' + body + '\n' : '-- 차이가 없다\n', statements, dangers, items };
}

// 0) 이름 바꾸기를 맨 먼저: 아래 문장은 모두 새 이름을 쓴다. 테이블을 먼저 바꾸고 컬럼은 새 테이블 이름으로 바꾼다
//    (전에는 이름 바꾸기가 삭제와 추가로 나와 데이터가 사라질 수 있었다, 2026-10-16 화면 재현)
function renames({ w, items, section }: AlterContext): void {
  const lines = section('이름 바꾸기');
  for (const i of items.filter(x => x.change === 'rename' && x.kind === 'table')) lines.push(w.renameTable(i.from as string, i.to as string));
  for (const i of items.filter(x => x.change === 'rename' && x.kind === 'column')) lines.push(w.renameColumn(i.table!, i.from as string, i.to as string));
}

// 1) 지울 FK, UNIQUE, CHECK, 인덱스 (바뀌는 것은 지우고 다시 만든다). 지울 테이블에 딸린 것은 테이블과 함께 사라진다
function dropKeys({ w, items, section, isTableDrop }: AlterContext): void {
  const lines = section('지울 FK, UNIQUE, CHECK, 인덱스');
  for (const i of items) {
    if (!['fk', 'unique', 'check', 'index'].includes(i.kind) || i.change === 'add' || isTableDrop(i.table)) continue;
    lines.push(i.kind === 'index' ? w.dropIx(i.table!, i.name) : w.dropCon(i.table!, i.name));
  }
}

// 2) 지울 테이블
function dropTables({ w, items, section, warn }: AlterContext): void {
  const lines = section('지울 테이블');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'drop')) { warn(lines, `${i.name}: ${i.danger}`); lines.push(w.dropTable(i.name)); }
}

// 3) 새 시퀀스 (새 테이블 기본값 nextval 이 먼저 필요)
function addSequences({ w, items, section }: AlterContext): void {
  const lines = section('새 시퀀스, 바뀐 시퀀스');
  for (const i of items.filter(x => x.kind === 'sequence' && x.change !== 'drop')) {
    const s = i.to as Sequence;
    lines.push(i.change === 'add' ? w.createSeq(s) : w.alterSeq(s));
  }
}

// 4) 있는 테이블의 컬럼과 PK.
//    PK 는 먼저 지우고 컬럼을 바꾼 뒤 다시 만든다: PK 에 든 컬럼은 NOT NULL 을 풀 수 없다 (dev 실제 적용 시험에서 확인)
function columnsAndPk({ w, items, fromTables, toTables, section, warn, isTableAdd, isTableDrop }: AlterContext): void {
  const pkDrops = section('바뀌는 PK 지우기');
  for (const i of items) {
    if (i.kind === 'pk' && i.change !== 'add' && !isTableAdd(i.table) && !isTableDrop(i.table)) pkDrops.push(w.dropPk(i.table!));
  }
  const colLines = section('컬럼 변경, 추가, 삭제');
  for (const i of items) {
    if (isTableAdd(i.table) || isTableDrop(i.table) || i.kind === 'pk') continue;
    if (i.kind === 'column' && i.change === 'add') {
      warn(colLines, i.danger && `${i.table}.${i.name}: ${i.danger}`);
      colLines.push(...w.addColumn(i.table!, i.to as Column));
    } else if (i.kind === 'column' && i.change === 'drop') {
      warn(colLines, `${i.table}.${i.name}: ${i.danger}`);
      colLines.push(w.dropColumn(i.table!, i.name));
    } else if (i.kind === 'column' && i.change === 'alter') {
      warn(colLines, i.danger && `${i.table}.${i.name}: ${i.danger}`);
      colLines.push(...w.alterColumn(i.table!, i.from as Column, i.to as Column, { from: fromTables.get(i.table!), to: toTables.get(i.table!) }));
    } else if (i.kind === 'table' && i.change === 'alter') {
      colLines.push(...w.tableComment(i.table ?? '', (i.to as Table).comment || undefined));
    }
  }
  const pkAdds = section('바뀐 PK 만들기');
  for (const i of items) {
    if (i.kind !== 'pk' || isTableAdd(i.table) || isTableDrop(i.table)) continue;
    const pk = i.to as string[];
    if (pk.length) pkAdds.push(w.addPk(i.table!, pk));
  }
}

// 5) 새 테이블 (FK 는 7 에서 한꺼번에: 서로 참조하는 새 테이블이 있어도 순서 걱정이 없다)
function newTables({ w, items, toTables, section }: AlterContext): void {
  const lines = section('새 테이블');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    lines.push(w.createTable(t), ...w.comments(t));
  }
}

// 6) UNIQUE, CHECK, 인덱스 추가 (새 테이블 것 포함)
function addKeys({ w, items, toTables, section, isTableAdd }: AlterContext): void {
  const lines = section('새 UNIQUE, CHECK, 인덱스');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    lines.push(...t.uniques.map(u => w.addUq(t.name, u)), ...(t.checks ?? []).map(k => w.addCk(t.name, k)), ...t.indexes.map(x => w.addIx(t.name, x)));
  }
  for (const i of items) {
    if (i.change === 'drop' || i.change === 'rename' || isTableAdd(i.table)) continue;
    if (i.kind === 'unique') lines.push(w.addUq(i.table!, i.to as Unique));
    if (i.kind === 'check') lines.push(w.addCk(i.table!, i.to as Check));
    if (i.kind === 'index') lines.push(w.addIx(i.table!, i.to as Index));
  }
}

// 7) FK 추가
function addFks({ w, items, toTables, section, isTableAdd }: AlterContext): void {
  const lines = section('새 FK');
  for (const i of items.filter(x => x.kind === 'table' && x.change === 'add')) {
    const t = toTables.get(i.name)!;
    lines.push(...t.fks.map(f => w.addFk(t.name, f)));
  }
  for (const i of items) if (i.kind === 'fk' && i.change !== 'drop' && !isTableAdd(i.table)) lines.push(w.addFk(i.table!, i.to as ForeignKey));
}

// 8) 지울 시퀀스 (테이블 기본값이 더는 쓰지 않을 때)
function dropSequences({ w, items, section }: AlterContext): void {
  const lines = section('지울 시퀀스');
  for (const i of items.filter(x => x.kind === 'sequence' && x.change === 'drop')) lines.push(w.dropSeq(i.name));
}

// 9) 함수
function functions({ w, items, section, warn }: AlterContext): void {
  const lines = section('함수');
  for (const i of items.filter(x => x.kind === 'function')) {
    if (i.change === 'drop') { warn(lines, `${i.name}: ${i.danger}`); lines.push(w.dropFn(i.from as FunctionDef)); }
    else lines.push(w.fnSql(i.to as FunctionDef));
  }
}
