// 모델 전체 CREATE 문 (설계 6-2 포워드 1번). 빈 모델 → 이 모델의 ALTER 와 같으므로 buildAlter 를 그대로 쓴다.
// 순서: 시퀀스 → 테이블과 코멘트 → UNIQUE, 인덱스 → FK → 함수 (FK 를 마지막에 모아 테이블 순서를 신경 쓰지 않는다)

import { buildAlter } from './alter';
import type { SchemaModel } from '../model/types';

export interface CreateScript { sql: string; statements: number }

export function buildCreateAll(model: SchemaModel, opts: { functions?: boolean } = {}): CreateScript {
  const target = opts.functions === false ? { ...model, functions: [] } : model;
  const empty: SchemaModel = { ...target, tables: [], sequences: [], functions: [] };
  const r = buildAlter(empty, target);
  const fks = target.tables.reduce((n, t) => n + t.fks.length, 0);
  const head = `-- ERD 도구가 만든 전체 CREATE (테이블 ${target.tables.length}개, FK ${fks}개, 시퀀스 ${target.sequences.length}개, 함수 ${target.functions.length}개). 빈 스키마에서 실행한다\n`;
  return { sql: r.sql.replace(/^-- [^\n]*\n/, head), statements: r.statements };
}
