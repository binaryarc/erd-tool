// SQL 글자 다루기: 커서가 있는 문장 찾기, 이력 저장 전 리터럴 지우기.
// 문자열('..', E'..'), 따옴표 식별자("..), 주석(--, /* */), 달러 따옴표($$..$$, $tag$..$tag$) 안의 ; 와 숫자는 건드리지 않는다.

type Kind = 'code' | 'string' | 'ident' | 'comment' | 'dollar';
export interface Span { kind: Kind; start: number; end: number }

/** 글자를 종류별 구간으로 나눈다 */
export function scan(sql: string): Span[] {
  const spans: Span[] = [];
  let i = 0, codeStart = 0;
  const push = (kind: Kind, start: number, end: number) => { if (end > start) spans.push({ kind, start, end }); };
  while (i < sql.length) {
    const ch = sql[i], next = sql[i + 1];
    let end = -1, kind: Kind = 'code';
    if (ch === "'" || ((ch === 'E' || ch === 'e') && next === "'" && !/\w/.test(sql[i - 1] ?? ''))) {
      kind = 'string';
      let j = ch === "'" ? i + 1 : i + 2;
      const backslash = ch !== "'";
      while (j < sql.length) {
        if (backslash && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      end = Math.min(j + 1, sql.length);
    } else if (ch === '"') {
      kind = 'ident';
      const j = sql.indexOf('"', i + 1);
      end = j < 0 ? sql.length : j + 1;
    } else if (ch === '-' && next === '-') {
      kind = 'comment';
      const j = sql.indexOf('\n', i);
      end = j < 0 ? sql.length : j;
    } else if (ch === '/' && next === '*') {
      kind = 'comment';
      const j = sql.indexOf('*/', i + 2);
      end = j < 0 ? sql.length : j + 2;
    } else if (ch === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (m && !/\w/.test(sql[i - 1] ?? '')) {
        kind = 'dollar';
        const j = sql.indexOf(m[0], i + m[0].length);
        end = j < 0 ? sql.length : j + m[0].length;
      }
    }
    if (end < 0) { i++; continue; }
    push('code', codeStart, i);
    push(kind, i, end);
    i = codeStart = end;
  }
  push('code', codeStart, sql.length);
  return spans;
}

/** 코드 구간의 ; 로 문장을 나눈다 (빈 문장은 뺀다) */
export function splitStatements(sql: string): { start: number; end: number; text: string }[] {
  const cuts: number[] = [];
  for (const s of scan(sql)) {
    if (s.kind !== 'code') continue;
    for (let i = s.start; i < s.end; i++) if (sql[i] === ';') cuts.push(i);
  }
  const out: { start: number; end: number; text: string }[] = [];
  let start = 0;
  for (const c of [...cuts, sql.length]) {
    const text = sql.slice(start, c);
    if (text.trim()) {
      const lead = text.length - text.trimStart().length;
      out.push({ start: start + lead, end: start + text.trimEnd().length, text: text.trim() });
    }
    start = c + 1;
  }
  return out;
}

/** offset(글자 위치)이 있는 문장. 문장 사이 빈 곳이면 바로 앞 문장 */
export function statementAt(sql: string, offset: number) {
  const list = splitStatements(sql);
  return list.find(s => offset >= s.start && offset <= s.end + 1) ?? [...list].reverse().find(s => s.end < offset) ?? list[0];
}

/** 이력 저장 전 문자열, 숫자, 달러 따옴표 리터럴을 ? 로 바꾼다 (고객 데이터가 이력에 남지 않게, 설계 9장) */
export function stripLiterals(sql: string): string {
  return scan(sql).map(s => {
    const text = sql.slice(s.start, s.end);
    if (s.kind === 'string' || s.kind === 'dollar') return '?';
    if (s.kind !== 'code') return text;
    // 식별자 일부가 아닌 숫자만 (tbl1, t2.col 은 그대로)
    return text.replace(/(?<![\w.$])[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?(?![\w.])/gi, '?');
  }).join('').trim();
}
