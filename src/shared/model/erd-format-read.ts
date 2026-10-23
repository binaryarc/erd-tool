// .erd 모델 파일 읽기 (파서). 쓰기는 erd-format-write.ts, 둘이 같이 쓰는 것은 erd-format-common.ts (erd-format.ts 에서 나눔, 2026-10-23)

import { DIALECTS, type Dialect } from '../dialect/names';
import { MODEL_VERSION, type Column, type Domain, type FkAction, type ForeignKey, type FunctionDef, type GroupRule, type ModelError, type SchemaModel, type Table } from './types';
import { COMMON_MARK, DOMAIN_MARK, FUNCTIONS_DIR, FUNCTION_HEAD, IDENTITY_WORD, INDEX_FILE, cmp, unesc } from './erd-format-common';

const GENERATED_RE = /^GENERATED ALWAYS AS \((.*)\) STORED$/;
/** IDENTITY, IDENTITY_BD 뒤 (시작값,증가값). 둘 다 1 이면 적지 않는다 */
const IDENTITY_RE = /^(IDENTITY|IDENTITY_BD)(?:\((-?\d+),(-?\d+)\))?$/;

/** fkOptions 의 거꾸로. 모르는 글자가 남으면 undefined */
function parseFkOptions(s: string): Pick<ForeignKey, 'onDelete' | 'onUpdate' | 'deferrable'> | undefined {
  const out: Pick<ForeignKey, 'onDelete' | 'onUpdate' | 'deferrable'> = {};
  const act = '(RESTRICT|CASCADE|SET NULL|SET DEFAULT)';
  let rest = s.replace(new RegExp(` ON DELETE ${act}`), (_m, a: string) => { out.onDelete = a.toLowerCase() as FkAction; return ''; })
    .replace(new RegExp(` ON UPDATE ${act}`), (_m, a: string) => { out.onUpdate = a.toLowerCase() as FkAction; return ''; })
    .replace(/ DEFERRABLE( INITIALLY DEFERRED)?/, (_m, d?: string) => { out.deferrable = d ? 'deferred' : 'immediate'; return ''; });
  rest = rest.trim();
  return rest ? undefined : out;
}

// ---------- 읽기 ----------

export interface ParseResult {
  model: SchemaModel;
  errors: ModelError[];
  /** 검증 메시지에 줄 번호를 붙이기 위한 위치 (키: 테이블 이름, 또는 '테이블 FK이름') */
  where: Map<string, { file: string; line: number }>;
}

export function parseModel(files: Record<string, string>): ParseResult {
  const errors: ModelError[] = [];
  const where = new Map<string, { file: string; line: number }>();
  const model: SchemaModel = { version: MODEL_VERSION, groups: [], common: [], sequences: [], tables: [], functions: [] };

  const index = files[INDEX_FILE];
  if (index === undefined) errors.push({ file: INDEX_FILE, line: 0, message: '파일이 없습니다' });
  else parseIndex(index, model, errors);

  for (const file of Object.keys(files).filter(f => f.startsWith(FUNCTIONS_DIR)).sort(cmp)) {
    parseFunctions(file, files[file], model, errors);
  }

  for (const file of Object.keys(files).filter(f => f !== INDEX_FILE && f.endsWith('.erd')).sort(cmp)) {
    let cur: Table | undefined;
    let wantCommon = false;
    const finish = () => { if (cur && wantCommon) cur.columns.push(...model.common.map(c => ({ ...c }))); };
    lines(files[file]).forEach((raw, i) => {
      const line = i + 1;
      const err = (message: string) => errors.push({ file, line, message });
      if (!raw.trim()) return;
      if (!raw.startsWith('  ')) {
        finish();
        const m = raw.match(/^(\S+) @(\S+)(?: (.*))?$/);
        if (!m) { cur = undefined; return err(`테이블 줄 형식이 아닙니다: ${raw}`); }
        let rest = m[3] ?? '';
        wantCommon = rest === COMMON_MARK || rest.endsWith(' ' + COMMON_MARK);
        if (wantCommon) rest = rest.slice(0, rest.length - COMMON_MARK.length).trimEnd();
        cur = { id: m[2], name: m[1], comment: unesc(rest), columns: [], pk: [], fks: [], uniques: [], indexes: [] };
        model.tables.push(cur);
        where.set(cur.name, { file, line });
        return;
      }
      if (!cur) return err('테이블 줄 없이 컬럼이나 키 줄이 나왔습니다');
      const body = raw.slice(2);
      if (body.startsWith('PK (')) {
        const m = body.match(/^PK \((.+)\)$/);
        if (!m) return err(`PK 줄 형식이 아닙니다: ${body}`);
        cur.pk = splitList(m[1]);
      } else if (body.startsWith('FK ')) {
        const m = body.match(/^FK (\S+) \(([^)]+)\) > ([^\s(]+)\(([^)]+)\)(.*)$/);
        const opts = m && parseFkOptions(m[5]);
        if (!m || !opts) return err(`FK 줄 형식이 아닙니다: ${body}`);
        cur.fks.push({ name: m[1], columns: splitList(m[2]), refTable: m[3], refColumns: splitList(m[4]), ...opts });
        where.set(`${cur.name} ${m[1]}`, { file, line });
      } else if (body.startsWith('UQ ')) {
        const m = body.match(/^UQ (\S+) \((.+)\)$/);
        if (!m) return err(`UQ 줄 형식이 아닙니다: ${body}`);
        cur.uniques.push({ name: m[1], columns: splitList(m[2]) });
      } else if (body.startsWith('IX ')) {
        const m = body.match(/^IX (\S+) \((.+)\)( UNIQUE)?$/);
        if (!m) return err(`IX 줄 형식이 아닙니다: ${body}`);
        cur.indexes.push({ name: m[1], columns: splitList(m[2]), unique: !!m[3] });
      } else if (body.startsWith('CK ')) {
        const m = body.match(/^CK (\S+) (.+)$/);
        if (!m) return err(`CK 줄 형식이 아닙니다: ${body}`);
        (cur.checks ??= []).push({ name: m[1], definition: m[2] });
      } else {
        const c = parseColumn(body, err);
        if (!c) return;
        if (c.pk) cur.pk.push(c.column.name);
        cur.columns.push(c.column);
      }
    });
    finish();
  }
  return { model, errors, where };
}

/** `-- erd-function 이름(인자)` 줄로 나뉜 함수 정의들 */
function parseFunctions(file: string, text: string, model: SchemaModel, errors: ModelError[]) {
  let cur: FunctionDef | undefined;
  let body: string[] = [];
  const finish = () => {
    if (!cur) return;
    while (body.length && body[body.length - 1] === '') body.pop();
    cur.definition = body.join('\n');
    model.functions.push(cur);
  };
  lines(text).forEach((raw, i) => {
    if (raw.startsWith(FUNCTION_HEAD)) {
      finish();
      const m = raw.slice(FUNCTION_HEAD.length).match(/^([^(]+)\((.*)\)$/);
      if (!m) { cur = undefined; errors.push({ file, line: i + 1, message: `함수 머리 줄 형식이 아닙니다: ${raw}` }); return; }
      cur = { name: m[1], args: m[2], definition: '' };
      body = [];
    } else if (cur) body.push(raw);
    else if (raw.trim()) errors.push({ file, line: i + 1, message: '함수 머리 줄 없이 본문이 나왔습니다' });
  });
  finish();
}

function parseIndex(text: string, model: SchemaModel, errors: ModelError[]) {
  lines(text).forEach((raw, i) => {
    const err = (message: string) => errors.push({ file: INDEX_FILE, line: i + 1, message });
    if (!raw.trim()) return;
    const [kw, ...rest] = raw.split(' ');
    if (kw === 'erd-model') {
      // 버전 1 은 db 줄이 없다: DB 종류를 비워 두면 PostgreSQL, public 으로 본다. 버전 2 는 도메인이 없다. 다음 저장 때 지금 버전으로 쓴다
      if (rest[0] !== '1' && rest[0] !== '2' && Number(rest[0]) !== MODEL_VERSION) err(`지원하지 않는 형식 버전: ${rest[0]}`);
    } else if (kw === 'db') {
      if (!DIALECTS.includes(rest[0] as Dialect) || !rest[1]) return err(`db 줄 형식이 아닙니다: ${raw}`);
      model.dialect = rest[0] as Dialect;
      model.schema = rest[1];
    } else if (kw === 'group') {
      const g: GroupRule = { name: rest[0] };
      for (const opt of rest.slice(1)) {
        if (opt === 'default') g.isDefault = true;
        else if (opt.startsWith('prefix=')) g.prefix = opt.slice(7);
        else err(`알 수 없는 그룹 옵션: ${opt}`);
      }
      model.groups.push(g);
    } else if (kw === 'common') {
      const c = parseColumn(rest.join(' '), err);
      if (c) model.common.push(c.column);
    } else if (kw === 'domain') {
      if (rest.length < 2 || !rest[0]) return err(`domain 줄 형식이 아닙니다: ${raw}`);
      const d: Domain = { name: rest[0], type: rest.slice(1).join(' ') };
      (model.domains ??= []).push(d);
    } else if (kw === 'seq') {
      const m = raw.match(/^seq (\S+) start=(-?\d+) inc=(-?\d+)$/);
      if (!m) return err(`seq 줄 형식이 아닙니다: ${raw}`);
      model.sequences.push({ name: m[1], start: Number(m[2]), inc: Number(m[3]) });
    } else err(`알 수 없는 줄: ${raw}`);
  });
}

/** `이름 타입 [PK] [NN] [=기본값] [#코멘트]` — 타입은 공백을 포함할 수 있어 PK, NN, =, # 앞까지가 타입이다 */
export function parseColumn(body: string, err: (m: string) => void): { column: Column; pk: boolean } | undefined {
  const hash = findUnquoted(body, ' #');
  const comment = hash >= 0 ? unesc(body.slice(hash + 2)) : undefined;
  const main = hash >= 0 ? body.slice(0, hash) : body;
  const eq = findUnquoted(main, ' =');
  const dflt = eq >= 0 ? main.slice(eq + 2) : undefined;
  const words = (eq >= 0 ? main.slice(0, eq) : main).split(' ');
  if (words.length < 2) { err(`컬럼 줄 형식이 아닙니다: ${body}`); return undefined; }
  const name = words[0];
  let pk = false, notNull = false, k = words.length;
  let identity: Column['identity'], idArgs: RegExpMatchArray | null = null;
  let domain: string | undefined;
  while (k > 2 && (words[k - 1] === 'PK' || words[k - 1] === 'NN' || IDENTITY_RE.test(words[k - 1]) || (words[k - 1].startsWith(DOMAIN_MARK) && words[k - 1].length > 1))) {
    const w = words[k - 1];
    if (w === 'PK') pk = true;
    else if (w === 'NN') notNull = true;
    else if (w.startsWith(DOMAIN_MARK)) domain = w.slice(DOMAIN_MARK.length);
    else { idArgs = w.match(IDENTITY_RE); identity = idArgs![1] === IDENTITY_WORD.always ? 'always' : 'default'; }
    k--;
  }
  const column: Column = { name, type: words.slice(1, k).join(' '), notNull: notNull || pk || !!identity };
  if (domain) column.domain = domain;
  if (identity) column.identity = identity;
  if (idArgs?.[2] !== undefined) { column.identityStart = Number(idArgs[2]); column.identityStep = Number(idArgs[3]); }
  const gen = dflt?.match(GENERATED_RE);
  if (gen) column.generated = gen[1];
  else if (dflt !== undefined) column.default = dflt;
  if (comment) column.comment = comment;
  return { column, pk };
}

/** 작은따옴표 밖에서 처음 나오는 needle 위치 */
function findUnquoted(s: string, needle: string): number {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "'") q = !q;
    else if (!q && s.startsWith(needle, i)) return i;
  }
  return -1;
}

/** 괄호 밖 쉼표로 나눈다 (식 인덱스 lower(a, b) 보호) */
function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0, q = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") q = !q;
    else if (!q && ch === '(') depth++;
    else if (!q && ch === ')') depth--;
    else if (!q && depth === 0 && ch === ',') { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

function lines(text: string): string[] {
  const ls = text.replace(/\r\n/g, '\n').split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}
