// DB 종류별 규칙 (STEP 9). 화면과 메인이 같이 쓰는 것만 둔다: SQL 글자 규칙, 타입 이름, 자동완성 키워드, DDL 작성기.
// 접속, 세션, 카탈로그 읽기처럼 드라이버가 필요한 것은 메인의 main/db/adapters/ 에 있다.

import type { TextRules } from '../sql/text';
import type { Check, Column, ForeignKey, FunctionDef, Index, Sequence, Table, Unique } from '../model/types';
import { postgresql } from './postgresql';
import { sqlserver } from './sqlserver';
import { mysql } from './mysql';
import { oracle } from './oracle';
import { DIALECT_LABEL, type Dialect } from './names';

export * from './names';

export interface DdlOptions {
  /** Flyway 파일용: 스키마 접두어와 여러 번 실행해도 안전한 문장 (PostgreSQL 만) */
  flyway?: boolean;
  /** 모델의 스키마 (SQL Server 확장 속성처럼 스키마 이름이 꼭 필요한 문장에 쓴다) */
  schema?: string;
}

/** 차이 하나를 문장으로 바꾸는 함수들. 순서와 묶음은 sql/alter.ts 가 정한다 */
export interface DdlWriter {
  /** 테이블 이름 (flyway 면 스키마 접두어) */
  n(name: string): string;
  /** 식별자 따옴표 */
  q(name: string): string;
  createTable(t: Table): string;
  /** 새 테이블의 테이블, 컬럼 코멘트 */
  comments(t: Table): string[];
  tableComment(t: string, comment: string | undefined): string[];
  addFk(t: string, k: ForeignKey): string;
  addUq(t: string, u: Unique): string;
  addCk(t: string, c: Check): string;
  renameTable(from: string, to: string): string;
  renameColumn(t: string, from: string, to: string): string;
  addPk(t: string, pk: string[]): string;
  dropPk(t: string): string;
  addIx(t: string, i: Index): string;
  dropIx(t: string, name: string): string;
  dropCon(t: string, name: string): string;
  dropTable(t: string): string;
  addColumn(t: string, c: Column): string[];
  dropColumn(t: string, c: string): string;
  /** 있는 컬럼 a 를 b 로 바꾸는 문장들. from, to 는 바꾸기 전과 뒤의 테이블 (컬럼이 든 인덱스를 다시 만들어야 하는 DB 용) */
  alterColumn(t: string, a: Column, b: Column, tables?: { from?: Table; to?: Table }): string[];
  createSeq(s: Sequence): string;
  alterSeq(s: Sequence): string;
  dropSeq(s: string): string;
  fnSql(fn: FunctionDef): string;
  dropFn(fn: FunctionDef): string;
}

export interface DialectRules {
  name: Dialect;
  /** 화면 표시 이름 */
  label: string;
  defaultPort: number;
  text: TextRules;
  /** 접속한 DB 가 돌려주는 긴 타입 이름을 짧은 이름으로 */
  shortType(t: string): string;
  /** 사람이 친 타입 → 리버스가 돌려주는 모양 (소문자, 공백 정리 뒤 적용) */
  typeInput: Record<string, string>;
  keywords: string[];
  functions: string[];
  /** SELECT 끝에 붙일 행 수 제한 (SQL Server 는 앞에 TOP 을 넣는다) */
  limitSelect(select: string, n: number): string;
  ddl(o?: DdlOptions): DdlWriter;
  /** 서버가 읽기 전용을 막는가. 아니면 DB 계정 권한으로 막아야 한다 (사용자 결정 2026-10-16) */
  readOnlyByServer: boolean;
}

// 부를 때 만든다: 모델 모듈과 서로 불러오는 고리 때문에 모듈을 읽는 순간에는 규칙 객체가 아직 없을 수 있다
const registry = (): Record<Dialect, DialectRules> => ({ postgresql, sqlserver, mysql, oracle });

export function rulesFor(d: Dialect = 'postgresql'): DialectRules {
  const r = registry()[d];
  if (!r) throw new Error(`아직 지원하지 않는 DB: ${DIALECT_LABEL[d] ?? d}`);
  return r;
}

/** 사람이 친 타입을 리버스가 돌려주는 모양으로 맞춘다. 다르면 DB 에 적용하고 다시 읽을 때 차이로 나온다 */
export function normalizeTypeFor(d: Dialect, input: string): string {
  const r = rulesFor(d);
  const t = r.shortType(input.trim().replace(/\s+/g, ' ').toLowerCase()).replace(/\s*\(\s*/, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/, ')');
  return r.typeInput[t] ?? t;
}
