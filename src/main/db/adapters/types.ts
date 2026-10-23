// DB 어댑터 공통 틀 (STEP 9). 접속, 세션(트랜잭션, savepoint, 커서), 카탈로그 읽기를 DB 종류마다 구현한다.
// 화면과 같이 쓰는 규칙(글자, 타입, DDL)은 shared/dialect/ 에 있다.

import type { Dialect } from '../../../shared/dialect/names';
import type { SqlCatalog } from '../../../shared/ipc';
import type { FunctionDef, Sequence, Table } from '../../../shared/model/types';

export interface Target {
  dialect: Dialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  readOnly: boolean;
  /** 비우면 DB 종류 기본 스키마 (adapter.defaultSchema) */
  schema?: string;
  /** SQL Server 자체 서명 인증서를 믿는다 */
  trustCert?: boolean;
}

/** 커서로 읽은 한 묶음. 값은 숫자, 참거짓 외에는 DB 가 준 글자 그대로 */
export interface CursorRead {
  rows: unknown[][];
  /** 결과 컬럼 이름 (결과가 없는 문장은 빈 배열) */
  fields: string[];
  /** SELECT, UPDATE 등. 드라이버가 알려주지 않으면 문장 첫 단어 */
  command: string;
  /** 바뀐 행 수 (결과 없는 문장) */
  rowCount: number | null;
}

export interface RowCursor {
  /** 최대 n 행. 끝까지 읽었으면 n 보다 적다 */
  read(n: number): Promise<CursorRead>;
  /** 다 읽기 전에 닫는다 */
  close(): Promise<void>;
}

export interface DbConn {
  /** 내부 조회용: 행을 이름 → 값 객체로 */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** 결과를 쓰지 않는 문장 */
  exec(sql: string): Promise<void>;
  /** 사용자 문장. 커서가 열린 동안 이 연결은 다른 문장을 받지 않는다 */
  cursor(sql: string): RowCursor;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
  /** savepoint 풀기 (없는 DB 는 아무것도 안 한다) */
  release(name: string): Promise<void>;
  /** 이 연결의 다음 트랜잭션부터 읽기 전용 켜고 끄기 (서버가 못 막는 DB 는 아무것도 안 한다) */
  setReadOnly(on: boolean): Promise<void>;
  /** 트랜잭션이 아직 열려 있는가. 한 문장 실패로 트랜잭션 전체가 끝날 수 있는 DB(SQL Server)만 둔다 */
  inTx?(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ReverseRaw {
  tables: Table[];
  sequences: Sequence[];
  functions: FunctionDef[];
  /** 모델에 담지 못한 것 (뷰, 부분 인덱스 등) */
  warnings: string[];
}

export interface SqlError { message: string; code?: string; position?: number }

export interface DbAdapter {
  dialect: Dialect;
  connect(t: Target, readOnly: boolean): Promise<DbConn>;
  /** 비밀번호가 틀려 거부됐는가 (BE 프로필이면 기억한 비밀번호를 지우고 다시 묻는다) */
  isAuthError(e: unknown): boolean;
  /** 화면에 보일 오류 (코드, 문장 안 글자 위치) */
  errorInfo(e: unknown): SqlError;
  defaultSchema(t: Target): string;
  reverse(c: DbConn, schema: string): Promise<ReverseRaw>;
  /** 직접 센 테이블 수, FK 수 (완료 기준 대조용) */
  count(c: DbConn, schema: string): Promise<{ tables: number; fks: number }>;
  catalog(c: DbConn): Promise<SqlCatalog>;
  serverInfo(c: DbConn): Promise<{ database: string; version: string }>;
  /** AI 조회: 시간 제한을 걸고 읽기 전용 트랜잭션을 연다. 서버가 못 막는 DB 는 트랜잭션만 연다 (끝에 항상 롤백) */
  beginAiQuery(c: DbConn, timeoutMs: number): Promise<void>;
}

/**
 * 이벤트로 한 행씩 오는 드라이버(mysql2, mssql)의 커서가 같이 쓰는 대기 처리.
 * 행을 모아 두고, read(n) 이 n 행이 차거나 끝날 때까지 기다리게 한다. 드라이버를 멈추고 푸는 방법은 DB 마다 달라 호출하는 쪽이 넘긴다.
 */
export function rowBuffer() {
  const buf: unknown[][] = [];
  let want = 0, done = false, err: unknown = null;
  let wake: (() => void) | null = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  return {
    get done() { return done; },
    /** 행을 더한다. 읽으려는 만큼 찼으면 pause 로 드라이버를 멈추고 기다리는 read 를 깨운다 */
    push(row: unknown[], pause: () => void) {
      buf.push(row);
      if (buf.length >= want) { pause(); poke(); }
    },
    /** 첫 오류만 기억한다. 기다리는 read 는 깨우지 않는다 (끝났다는 신호가 깨운다) */
    fail(e: unknown) { err ??= e; },
    /** 더 올 행이 없다 */
    finish() { done = true; poke(); },
    /** n 행이 차거나 끝날 때까지 기다렸다가 n 행까지 꺼낸다. 기다리기 전에 resume 으로 드라이버를 푼다. 오류가 있으면 던진다 */
    async take(n: number, resume: () => void): Promise<unknown[][]> {
      want = n;
      while (buf.length < n && !done) await new Promise<void>(ok => { wake = ok; resume(); });
      if (err) throw err;
      return buf.splice(0, n);
    },
    /** 다 받기 전에 닫을 때: 쌓인 행을 버리고 앞으로 오는 행도 쌓지 않게 한다 */
    discard() { want = Infinity; buf.length = 0; },
    /** 끝났다는 신호(finish)를 기다린다. timeoutMs 가 있으면 그 시간이 지나도 풀린다 */
    wait(timeoutMs?: number) {
      return new Promise<void>(ok => { wake = ok; if (timeoutMs) setTimeout(ok, timeoutMs); });
    },
  };
}

/** 드라이버가 명령 이름을 주지 않을 때: 문장 첫 단어 (앞 주석은 뗀다) */
export function firstWord(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '').match(/^[a-z]+/i)?.[0].toUpperCase() ?? '';
}

/** 생성식을 DDL 에 다시 괄호로 씌우기 때문에, 시스템 표가 붙여 준 바깥 괄호 한 겹을 벗긴다. (a) + (b) 는 그대로 둔다 */
export function stripParens(s: string): string {
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0 && i < s.length - 1) return s; // 첫 괄호가 끝보다 먼저 닫힌다
  }
  return s.slice(1, -1);
}
