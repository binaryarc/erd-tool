// 모델 파일 쓰기(erd-format-write.ts)와 읽기(erd-format-read.ts)가 같이 쓰는 표기 상수와 도구 (erd-format.ts 에서 나눔, 2026-10-23)

import type { Column, GroupRule } from './types';

export const INDEX_FILE = '_index.erd';
export const FUNCTIONS_DIR = 'functions/';
/** 테이블을 모두 담는 파일 */
export const TABLES_FILE = 'tables.erd';
export const COMMON_MARK = '+common';
export const FUNCTION_HEAD = '-- erd-function ';

export const IDENTITY_WORD = { always: 'IDENTITY', default: 'IDENTITY_BD' } as const;
/** 컬럼 줄에서 타입 뒤 도메인 표시: %도메인이름 (STEP 10) */
export const DOMAIN_MARK = '%';
export const identityArgs = (c: Column) =>
  (c.identityStart ?? 1) !== 1 || (c.identityStep ?? 1) !== 1 ? `(${c.identityStart ?? 1},${c.identityStep ?? 1})` : '';

/** 기본값 자리: 생성 컬럼은 생성식을 DDL 모양 그대로 둔다 */
export const defaultText = (c: Column) => (c.generated !== undefined ? `GENERATED ALWAYS AS (${c.generated}) STORED` : c.default);

/** 컬럼 끝부분이 공통 컬럼 정의와 완전히 같을 때만 +common 으로 줄인다 (정보 손실 없음) */
export function endsWithCommon(cols: Column[], common: Column[]): boolean {
  if (!common.length || cols.length < common.length) return false;
  const tail = cols.slice(cols.length - common.length);
  return tail.every((c, i) => sameColumn(c, common[i]));
}

export function sameColumn(a: Column, b: Column): boolean {
  return a.name === b.name && a.type === b.type && a.notNull === b.notNull
    && a.default === b.default && (a.comment ?? '') === (b.comment ?? '')
    && a.identity === b.identity && a.generated === b.generated && identityArgs(a) === identityArgs(b) && a.domain === b.domain;
}

export function groupOf(table: string, groups: GroupRule[]): string {
  return groups.find(g => g.prefix && table.startsWith(g.prefix))?.name
    ?? groups.find(g => g.isDefault)?.name
    ?? '_';
}

// 코멘트 안 줄바꿈과 역슬래시를 한 줄로 저장한다
export const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
export const unesc = (s: string) => s.replace(/\\(\\|n|r)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : '\\'));

// 로캘과 상관없이 항상 같은 순서
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
