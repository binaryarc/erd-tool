// SQL 글자 다루기: 커서가 있는 문장 찾기, 이력 저장 전 리터럴 지우기.
// 문자열('..', E'..'), 따옴표 식별자("..), 주석(--, /* */), 달러 따옴표($$..$$, $tag$..$tag$) 안의 ; 와 숫자는 건드리지 않는다.
// DB 종류마다 글자 규칙(TextRules)이 다르다. 규칙을 주지 않으면 PostgreSQL 규칙이다.

type Kind = 'code' | 'string' | 'ident' | 'comment' | 'dollar' | 'sep';
export interface Span { kind: Kind; start: number; end: number }

export interface TextRules {
  /** E'..' 백슬래시 문자열 (PostgreSQL) */
  eString?: boolean;
  /** '..', ".." 안에서 \ 가 다음 글자를 감싼다 (MySQL) */
  backslash?: boolean;
  /** $$..$$ 달러 따옴표 (PostgreSQL) */
  dollar?: boolean;
  /** [..] 식별자 (SQL Server) */
  bracket?: boolean;
  /** `..` 식별자 (MySQL) */
  backtick?: boolean;
  /** "..": 문자열 (MySQL 기본) */
  doubleQuoteString?: boolean;
  /** # 한 줄 주석 (MySQL) */
  hash?: boolean;
  /** 줄에 혼자 있으면 문장을 끊는 글자 (SQL Server GO, Oracle /) */
  lineSep?: RegExp;
  /** PL/SQL 블록(BEGIN, DECLARE, CREATE PROCEDURE 등)은 ; 로 끊지 않고 lineSep 줄까지 한 문장 (Oracle) */
  plsql?: boolean;
}

export const PG_TEXT: TextRules = { eString: true, dollar: true };

/** 글자를 종류별 구간으로 나눈다 */
export function scan(sql: string, r: TextRules = PG_TEXT): Span[] {
  const spans: Span[] = [];
  let i = 0, codeStart = 0;
  const push = (kind: Kind, start: number, end: number) => { if (end > start) spans.push({ kind, start, end }); };
  while (i < sql.length) {
    const ch = sql[i], next = sql[i + 1];
    let end = -1, kind: Kind = 'code';
    const eStr = r.eString && (ch === 'E' || ch === 'e') && next === "'" && !/\w/.test(sql[i - 1] ?? '');
    if (ch === "'" || eStr || (ch === '"' && r.doubleQuoteString)) {
      kind = 'string';
      const quote = eStr ? "'" : ch;
      let j = eStr ? i + 2 : i + 1;
      const backslash = eStr || !!r.backslash;
      while (j < sql.length) {
        if (backslash && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === quote) { if (sql[j + 1] === quote) { j += 2; continue; } break; }
        j++;
      }
      end = Math.min(j + 1, sql.length);
    } else if (ch === '"' || (ch === '[' && r.bracket) || (ch === '`' && r.backtick)) {
      kind = 'ident';
      const j = sql.indexOf(ch === '[' ? ']' : ch, i + 1);
      end = j < 0 ? sql.length : j + 1;
    } else if ((ch === '-' && next === '-') || (ch === '#' && r.hash)) {
      kind = 'comment';
      const j = sql.indexOf('\n', i);
      end = j < 0 ? sql.length : j;
    } else if (ch === '/' && next === '*') {
      kind = 'comment';
      const j = sql.indexOf('*/', i + 2);
      end = j < 0 ? sql.length : j + 2;
    } else if (ch === '$' && r.dollar) {
      const m = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (m && !/\w/.test(sql[i - 1] ?? '')) {
        kind = 'dollar';
        const j = sql.indexOf(m[0], i + m[0].length);
        end = j < 0 ? sql.length : j + m[0].length;
      }
    } else if (r.lineSep && (i === 0 || sql[i - 1] === '\n')) {
      // 줄 처음에서만 본다: 줄 끝까지가 구분자 한 줄인가
      const nl = sql.indexOf('\n', i);
      const line = sql.slice(i, nl < 0 ? sql.length : nl);
      if (r.lineSep.test(line)) { kind = 'sep'; end = nl < 0 ? sql.length : nl; }
    }
    if (end < 0) { i++; continue; }
    push('code', codeStart, i);
    push(kind, i, end);
    i = codeStart = end;
  }
  push('code', codeStart, sql.length);
  return spans;
}

const PLSQL_HEAD = /^(?:begin|declare|create\s+(?:or\s+replace\s+)?(?:(?:editionable|noneditionable)\s+)?(?:procedure|function|trigger|package|type\s+body|type))\b/i;
const LEADING = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

/** PL/SQL 블록인가 (앞 주석은 떼고 본다). 블록은 끝 ; 를 떼면 안 된다 */
export const isPlsqlBlock = (text: string) => PLSQL_HEAD.test(text.replace(LEADING, ''));

/** 코드 구간의 ; 와 구분자 줄로 문장을 나눈다 (빈 문장은 뺀다) */
export function splitStatements(sql: string, r: TextRules = PG_TEXT): { start: number; end: number; text: string }[] {
  const cuts: { at: number; len: number; sep: boolean }[] = [];
  for (const s of scan(sql, r)) {
    if (s.kind === 'sep') cuts.push({ at: s.start, len: s.end - s.start, sep: true });
    if (s.kind !== 'code') continue;
    for (let i = s.start; i < s.end; i++) if (sql[i] === ';') cuts.push({ at: i, len: 1, sep: false });
  }
  const out: { start: number; end: number; text: string }[] = [];
  let start = 0;
  for (const c of [...cuts, { at: sql.length, len: 0, sep: true }]) {
    // PL/SQL 블록 안의 ; 는 끊지 않는다. 블록은 ; 까지 문장에 넣는다
    if (!c.sep && r.plsql && isPlsqlBlock(sql.slice(start, c.at))) continue;
    const text = sql.slice(start, c.at);
    if (text.trim()) {
      const lead = text.length - text.trimStart().length;
      out.push({ start: start + lead, end: start + text.trimEnd().length, text: text.trim() });
    }
    start = c.at + c.len;
  }
  return out;
}

/** offset(글자 위치)이 있는 문장. 문장 사이 빈 곳이면 바로 앞 문장 */
export function statementAt(sql: string, offset: number, r: TextRules = PG_TEXT) {
  const list = splitStatements(sql, r);
  return list.find(s => offset >= s.start && offset <= s.end + 1) ?? [...list].reverse().find(s => s.end < offset) ?? list[0];
}

/** 이력 저장 전 문자열, 숫자, 달러 따옴표 리터럴을 ? 로 바꾼다 (고객 데이터가 이력에 남지 않게, 설계 9장) */
export function stripLiterals(sql: string, r: TextRules = PG_TEXT): string {
  return scan(sql, r).map(s => {
    const text = sql.slice(s.start, s.end);
    if (s.kind === 'string' || s.kind === 'dollar') return '?';
    if (s.kind !== 'code') return text;
    // 식별자 일부가 아닌 숫자만 (tbl1, t2.col 은 그대로)
    return text.replace(/(?<![\w.$])[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?(?![\w.])/gi, '?');
  }).join('').trim();
}
