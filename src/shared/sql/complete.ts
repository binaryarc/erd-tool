// SQL 자동완성 판단 (Monaco 와 떼어 두어 단위 시험을 한다). DBeaver 처럼 커서 위치에 맞는 것을 먼저 보여준다.
// - FROM, JOIN, INTO, UPDATE 뒤: 테이블, 뷰
// - SELECT, WHERE, ON, AND, SET, ORDER BY 등 뒤: 이 문장에 나온 테이블의 컬럼, 함수
// - 별칭. 또는 테이블. 뒤: 그 테이블 컬럼
// - 문장 처음: 구문 틀(SELECT ... FROM 등), 키워드
// - 문자열, 주석 안에서는 보여주지 않는다

import type { SqlCatalog } from '../ipc';
import { rulesFor } from '../dialect';
import { scan, splitStatements, type TextRules } from './text';

export type ItemKind = 'table' | 'view' | 'column' | 'function' | 'keyword' | 'snippet';
export interface Item {
  label: string;
  kind: ItemKind;
  insert: string;
  detail?: string;
  doc?: string;
  /** 정렬 순서 (작을수록 위) */
  sort: string;
  /** Monaco 스니펫 문법(${1:..})으로 넣는다 */
  snippet?: boolean;
}

const TABLE_KW = new Set(['from', 'join', 'into', 'update', 'table', 'truncate']);
const COLUMN_KW = new Set(['select', 'where', 'and', 'or', 'on', 'by', 'having', 'set', 'when', 'then', 'else', 'returning', 'distinct', 'not', 'using']);
const STOP_ALIAS = /^(where|join|left|right|inner|outer|full|cross|on|set|order|group|limit|offset|values|using|natural|lateral|returning|union|except|intersect|having|window|for)$/i;

const SNIPPETS: { label: string; insert: string; detail: string }[] = [
  { label: 'sel', detail: 'SELECT * FROM 테이블', insert: 'SELECT ${1:*}\n  FROM ${2:테이블}\n WHERE ${3:1 = 1};' },
  { label: 'selc', detail: '건수 세기', insert: 'SELECT count(*)\n  FROM ${1:테이블}\n WHERE ${2:1 = 1};' },
  { label: 'ins', detail: 'INSERT INTO ... VALUES', insert: 'INSERT INTO ${1:테이블} (${2:컬럼})\nVALUES (${3:값});' },
  { label: 'upd', detail: 'UPDATE ... SET ... WHERE', insert: 'UPDATE ${1:테이블}\n   SET ${2:컬럼} = ${3:값}\n WHERE ${4:조건};' },
  { label: 'del', detail: 'DELETE FROM ... WHERE', insert: 'DELETE FROM ${1:테이블}\n WHERE ${2:조건};' },
];

/** from/join 뒤 「테이블 [AS] 별칭」 을 찾아 별칭(과 테이블 이름) → 테이블 이름 */
export function aliasMap(sql: string, tableNames: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:from|join|update|into)\s+(?:([a-z_][\w]*)\.)?([a-z_][\w]*)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi;
  for (const m of sql.matchAll(re)) {
    const table = m[2].toLowerCase();
    if (!tableNames.has(table)) continue;
    map.set(table, table);
    const alias = m[3]?.toLowerCase();
    if (alias && !STOP_ALIAS.test(alias)) map.set(alias, table);
  }
  return map;
}

/** 커서가 문자열이나 주석 안인가: 커서 자리에 표시 글자를 붙여 훑고, 그 글자가 코드 구간 밖이면 안쪽이다 */
function inLiteral(before: string, r: TextRules): boolean {
  const s = before + '\u0001';
  const span = scan(s, r).find(x => x.start <= s.length - 1 && s.length - 1 < x.end);
  return !!span && span.kind !== 'code';
}

export function suggest(before: string, after: string, cat: SqlCatalog): Item[] {
  const rules = rulesFor(cat.dialect);
  if (inLiteral(before, rules.text)) return [];
  const full = before + after;
  const stmts = splitStatements(full, rules.text);
  const stmt = stmts.find(s => before.length >= s.start && before.length <= s.end + 1)?.text ?? '';
  // 커서 앞 같은 문장. 끝 공백을 자르면 「from 」 뒤 커서를 「from」 을 쓰는 중으로 잘못 보므로 원래 글자를 쓴다
  const lastStmt = splitStatements(before, rules.text).at(-1);
  const stmtBefore = lastStmt ? before.slice(lastStmt.start) : '';

  const tables = new Map(cat.tables.map(t => [t.name.toLowerCase(), t]));
  const aliases = aliasMap(stmt, new Set(tables.keys()));

  // 별칭.  테이블.
  const dot = before.match(/([a-z_][\w]*)\.(\w*)$/i);
  if (dot) {
    const name = dot[1].toLowerCase();
    const t = tables.get(aliases.get(name) ?? name);
    if (t) return t.columns.map((c, i) => ({ label: c.name, kind: 'column', insert: c.name, detail: c.type, doc: c.comment, sort: String(i).padStart(4, '0') }));
    // 스키마.  → 그 스키마의 테이블
    const inSchema = cat.tables.filter(x => x.schema.toLowerCase() === name);
    return inSchema.map(x => ({ label: x.name, kind: x.kind, insert: x.name, detail: x.comment, sort: '0' + x.name }));
  }

  // 지금 쓰는 단어를 빼고, 커서 앞의 마지막 키워드
  const words = stmtBefore.replace(/[a-z_]\w*$/i, '').match(/[a-z_]\w*|,/gi) ?? [];
  let last = '';
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].toLowerCase();
    if (TABLE_KW.has(w) || COLUMN_KW.has(w)) { last = w; break; }
  }
  const atStart = !stmtBefore.replace(/[a-z_]\w*$/i, '').trim();

  const tableItems = (rank: string): Item[] => cat.tables.map(t => ({
    label: t.name, kind: t.kind, insert: t.name, detail: `${t.kind === 'view' ? '뷰' : '테이블'}${t.comment ? ' ' + t.comment : ''}`, sort: rank + t.name,
  }));
  const keywordItems = (rank: string): Item[] => rules.keywords.map(k => ({ label: k, kind: 'keyword', insert: k, sort: rank + k }));
  const functionItems = (rank: string): Item[] => [
    ...cat.functions.map(f => ({ label: f.name, kind: 'function' as const, insert: `${f.name}($1)`, snippet: true, detail: `(${f.args}) ${f.returns}`, sort: rank + f.name })),
    ...rules.functions.filter(f => !cat.functions.some(x => x.name === f)).map(f => ({ label: f, kind: 'function' as const, insert: `${f}($1)`, snippet: true, detail: `${rules.label} 함수`, sort: rank + 'z' + f })),
  ];
  const columnItems = (rank: string): Item[] => {
    const used = [...new Set(aliases.values())];
    const seen = new Map<string, Item>();
    for (const n of used) for (const c of tables.get(n)?.columns ?? []) {
      const old = seen.get(c.name);
      if (old) old.detail += `, ${n}`;
      else seen.set(c.name, { label: c.name, kind: 'column', insert: c.name, detail: `${c.type} ${n}`, doc: c.comment, sort: rank + c.name });
    }
    return [...seen.values()];
  };

  if (atStart) {
    return [
      ...SNIPPETS.map(s => ({ label: s.label, kind: 'snippet' as const, insert: s.insert, detail: s.detail, snippet: true, sort: '0' + s.label })),
      ...keywordItems('1'),
    ];
  }
  if (TABLE_KW.has(last)) return [...tableItems('0'), ...keywordItems('2')];
  if (COLUMN_KW.has(last)) return [...columnItems('0'), ...functionItems('1'), ...keywordItems('2'), ...tableItems('3')];
  return [...keywordItems('0'), ...columnItems('1'), ...tableItems('2'), ...functionItems('3')];
}
