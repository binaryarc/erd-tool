// 차이 → Flyway 마이그레이션 파일 (STEP 7, 설계 8-2). 이름은 V{번호}__{설명}.sql, 본문은 여러 번 실행해도 안전한 문장.
// 본문은 buildAlter 의 flyway 선택 사항(모델의 스키마 접두어, 여러 번 실행해도 안전한 문장)으로 만들고,
// 맨 아래에 반대 방향 ALTER 를 한 줄마다 "-- " 를 붙인 ROLLBACK 주석 블록으로 둔다(Flyway 커뮤니티는 undo 없음).
// 파일을 만들 뿐 DB 에 실행하지 않는다.

import { DIFF_CHANGE_LABEL, DIFF_KIND_LABEL, diffModels, summarize, type DiffItem, type DiffKind } from '../model/diff';
import { buildAlter } from '../sql/alter';
import { dialectOf } from '../dialect/names';
import type { SchemaModel } from '../model/types';

const pad = (n: number) => String(n).padStart(2, '0');
/** 파일 이름에 붙이는 시각: 20261016_0912 */
export const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
/** 이력 표에 쓰는 시각: 2026-10-16 09:12 */
const dateTime = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * 폴더의 파일 이름들에서 다음 V 번호 (R__ 반복 실행 파일은 세지 않는다).
 * Flyway 는 V2_1__, V2.3__ 같은 점 버전도 받으므로 첫 마디(2)를 보고 그보다 큰 정수(V3)를 낸다.
 * V 로 시작하고 __ 가 있는 .sql 인데 버전을 읽을 수 없으면 낮은 번호를 낼 수 있어 거부한다
 */
export function nextVersion(fileNames: string[]): number {
  const bad: string[] = [];
  let max = 0;
  for (const f of fileNames) {
    if (!/^V.*__.*\.sql$/i.test(f)) continue;
    const m = /^V(\d+)(?:[._]\d+)*__.+\.sql$/i.exec(f);
    if (m) max = Math.max(max, Number(m[1])); else bad.push(f);
  }
  if (bad.length) throw new Error(`버전 번호를 읽을 수 없는 Flyway 파일이 있어 다음 번호를 정하지 못했습니다: ${bad.join(', ')}`);
  return max + 1;
}

/** 설명은 영문 소문자 snake_case */
export const validDescription = (d: string) => /^[a-z][a-z0-9_]*$/.test(d);

/** 차이로 설명을 미리 채운다: 테이블 하나만 바뀌면 add_x, drop_x, alter_x. 여럿이면 change_schema */
export function suggestDescription(items: DiffItem[]): string {
  const tables = [...new Set(items.map(i => i.table).filter((t): t is string => !!t))];
  if (tables.length !== 1) return items.every(i => i.kind === 'function') ? 'change_functions' : 'change_schema';
  const t = tables[0].toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const own = items.filter(i => i.table === tables[0]);
  if (own.some(i => i.kind === 'table' && i.change === 'add')) return `add_${t}`;
  if (own.some(i => i.kind === 'table' && i.change === 'drop')) return `drop_${t}`;
  if (own.every(i => i.kind === 'column' && i.change === 'add')) return `add_${t}_columns`;
  return `alter_${t}`;
}

export const flywayFileName = (version: number, description: string, now: Date) => `V${version}__${description}_${stamp(now)}.sql`;

const KIND = DIFF_KIND_LABEL;
const CHANGE = DIFF_CHANGE_LABEL;

/** 「테이블 추가 1, 컬럼 추가 2」 */
export function summaryText(items: DiffItem[]): string {
  const s = summarize(items);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(s)) for (const c of ['rename', 'add', 'drop', 'alter'] as const) if (v[c]) parts.push(`${KIND[k as DiffKind]} ${CHANGE[c]} ${v[c]}`);
  return parts.join(', ');
}

export interface FlywayInput {
  from: SchemaModel;
  to: SchemaModel;
  version: number;
  description: string;
  /** 머리 주석에 적는 비교 대상 이름 */
  fromLabel: string;
  toLabel: string;
  menuCode?: string;
  now: Date;
}

export interface FlywayFile {
  fileName: string;
  sql: string;
  statements: number;
  dangers: number;
  items: DiffItem[];
  /** 99-migration-history.md 「변경 이력」 표에 덧붙일 한 줄 */
  historyLine: string;
}

/** buildAlter 결과에서 맨 위 안내 주석 한 줄을 뗀다 */
const body = (sql: string) => sql.replace(/^-- [^\n]*\n\n?/, '').trimEnd();

export function buildFlyway(i: FlywayInput): FlywayFile {
  // 여러 번 실행해도 안전한 문장(DO 블록, IF NOT EXISTS)이 PostgreSQL 전용이다 (STEP 9 범위, 사용자 결정 2026-10-16)
  if (dialectOf(i.from.dialect ? i.from : i.to) !== 'postgresql') throw new Error('Flyway 파일은 PostgreSQL 모델에서만 만들 수 있습니다');
  if (!validDescription(i.description)) throw new Error(`설명은 영문 소문자 snake_case 로 적어 주세요: ${i.description}`);
  const items = diffModels(i.from, i.to);
  if (!items.length) throw new Error('차이가 없어 Flyway 파일을 만들지 않았습니다');
  const up = buildAlter(i.from, i.to, items, { flyway: true });
  const down = buildAlter(i.to, i.from, undefined, { flyway: true });
  const fileName = flywayFileName(i.version, i.description, i.now);
  const tables = [...new Set(items.map(x => x.table ?? x.name))];
  const summary = summaryText(items);

  const sql = [
    '-- ============================================================',
    `-- V${i.version}: ${i.description}${i.menuCode ? ` — ${i.menuCode}` : ''}`,
    '--',
    `--     ERD 도구가 ${i.fromLabel} 을(를) ${i.toLabel} 처럼 바꾸는 차이로 만들었다 (${dateTime(i.now)}).`,
    `--     차이 ${items.length}개: ${summary}. 위험 ${up.dangers}개 (본문의 [위험] 주석 참고).`,
    `--     대상: ${tables.join(', ')}`,
    '--     롤백 SQL 은 이 파일 맨 아래 "ROLLBACK (수동 실행용)" 주석 블록에 있다(Flyway 커뮤니티는 undo 미지원).',
    '--     ※ 이 파일에 달러+중괄호 형태는 쓰지 말 것 — Flyway 가 주석 안에서도 플레이스홀더로 해석한다.',
    '-- ============================================================',
    '',
    body(up.sql),
    '',
    '-- ============================================================',
    '-- ROLLBACK (수동 실행용 — Flyway 가 실행하지 않는다)',
    '--',
    '--     이 마이그레이션을 되돌려야 할 때 아래 SQL 을 psql 등으로 직접 실행한다.',
    `--     실행 후 flyway_schema_history 에서 version = '${i.version}' 행을 삭제해야`,
    '--     다음 기동 때 Flyway 가 이 파일을 다시 적용한다.',
    '--     ※ 주석을 풀어 실행문으로 바꾸지 말 것 — 그러면 UP 직후 되돌아간다.',
    '-- ============================================================',
    ...body(down.sql).split('\n').map(l => (l ? '-- ' + l : '--')),
    '',
  ].join('\n');
  // 함수 정의 등에 달러+중괄호가 섞이면 Flyway 기동이 멈춘다 (Flyway 가 플레이스홀더로 해석)
  if (sql.includes('${')) throw new Error('달러+중괄호 형태가 들어 있어 Flyway 가 플레이스홀더로 해석합니다. 그 부분을 고친 뒤 다시 만드세요');

  const historyLine = `| ${dateTime(i.now)} | ${i.menuCode || '-'} | ${tables.map(t => '`' + t + '`').join(', ')} | ${summary} — ${fileName} | - | - |`;
  return { fileName, sql, statements: up.statements, dangers: up.dangers, items, historyLine };
}

/** 99-migration-history.md 의 「변경 이력」 표 끝에 한 줄을 넣는다. 표를 못 찾으면 오류 */
export function appendHistoryLine(md: string, line: string): string {
  const lines = md.split('\n');
  const head = lines.findIndex(l => /^#+\s*변경 이력\s*$/.test(l));
  if (head < 0) throw new Error('「변경 이력」 절을 찾지 못했습니다');
  let i = head + 1;
  while (i < lines.length && !lines[i].startsWith('|')) i++;
  if (i >= lines.length) throw new Error('「변경 이력」 절에 표가 없습니다');
  while (i < lines.length && lines[i].startsWith('|')) i++;
  lines.splice(i, 0, line);
  return lines.join('\n');
}
