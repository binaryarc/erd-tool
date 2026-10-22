// 접속 시험과 리버스: 프로필로 접속 → 카탈로그 읽기 → 기존 모델에 맞춰 ID 유지 → 차이 목록 (저장은 하지 않는다)

import fs from 'node:fs';
import path from 'node:path';
import { detectCommon, groupsFromRulesJson, groupsFromPrefixes } from '../../shared/model/groups';
import { mergeModel } from '../../shared/model/merge';
import { emptyLayout } from '../../shared/model/layout';
import { MODEL_VERSION, type GroupRule, type SchemaModel } from '../../shared/model/types';
import type { ConnRef, ConnTestResult, ManualConn, ReverseResult } from '../../shared/ipc';
import { loadModel } from '../model-store';
import { DIALECT_LABEL } from '../../shared/dialect/names';
import { adapterFor } from './adapters';
import type { DbAdapter, DbConn, Target } from './adapters/types';
import { connectRef } from './connect';

// 리버스와 접속 시험은 읽기만 한다
export const testConnection = async (ref: ConnRef) => test(async () => connectRef(ref, true));
export const testDraft = async ({ driver, ...c }: ManualConn, password: string) => test(async () => {
  const target: Target = { ...c, dialect: driver, password };
  const adapter = await adapterFor(driver);
  return { conn: await adapter.connect(target, true), adapter, target };
});

async function test(open: () => Promise<{ conn: DbConn; adapter: DbAdapter; target: Target }>): Promise<ConnTestResult> {
  let conn: DbConn | undefined;
  try {
    const o = await open();
    conn = o.conn;
    const c = await o.adapter.count(conn, o.adapter.defaultSchema(o.target));
    const v = await o.adapter.serverInfo(conn);
    return { ok: true, message: `${v.database} 에 접속했습니다`, tables: c.tables, fks: c.fks, server: v.version };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  } finally {
    await conn?.close();
  }
}

/** 모델이 처음 생길 때 쓸 그룹 규칙 (설정의 groupRulesFile, groupPrefixes. 없어도 됨) */
export interface GroupSource { file?: string; prefixes?: string[] }

/** 그룹 규칙: 설정에 지정한 파일(erd-groups.json 형식), 설정의 접두어 목록, 모델 폴더 안의 erd-groups.json 순서. 모두 없으면 null */
function readGroupRules(modelDir: string, src: GroupSource = {}): GroupRule[] | null {
  const fromFile = (f: string) => groupsFromRulesJson(JSON.parse(fs.readFileSync(f, 'utf8')));
  if (src.file && fs.existsSync(src.file)) return fromFile(src.file);
  if (src.prefixes?.length) return groupsFromPrefixes(src.prefixes);
  const inModel = path.join(modelDir, 'erd-groups.json');
  return fs.existsSync(inModel) ? fromFile(inModel) : null;
}

export async function reverse(ref: ConnRef, modelDir: string, groupSource?: GroupSource): Promise<ReverseResult> {
  const loaded = fs.existsSync(path.join(modelDir, '_index.erd')) ? await loadModel(modelDir) : null;
  const prev = loaded?.model ?? null;
  const { conn, adapter, target } = await connectRef(ref, true);
  try {
    // 다른 DB 종류의 모델 폴더에 덮어쓰지 않는다
    if (prev && (prev.dialect ?? 'postgresql') !== adapter.dialect) {
      throw new Error(`이 모델 폴더는 ${DIALECT_LABEL[prev.dialect ?? 'postgresql']} 모델입니다. ${DIALECT_LABEL[adapter.dialect]} 접속은 다른 폴더로 불러오세요`);
    }
    const schema = adapter.defaultSchema(target);
    const raw = await adapter.reverse(conn, schema);
    const counts = await adapter.count(conn, schema);
    const next: SchemaModel = {
      version: MODEL_VERSION,
      dialect: adapter.dialect,
      schema,
      groups: prev?.groups.length ? prev.groups : (readGroupRules(modelDir, groupSource) ?? [{ name: 'main', isDefault: true }]),
      common: prev?.common.length ? prev.common : detectCommon(raw.tables),
      ...(prev?.domains ? { domains: prev.domains } : {}),
      sequences: raw.sequences,
      tables: raw.tables,
      functions: raw.functions,
    };
    const { model, diff, warnings } = mergeModel(prev, next);
    return { model, diff, warnings: [...raw.warnings, ...warnings], counts, hadModel: !!prev, layout: loaded?.layout ?? emptyLayout(), prev };
  } finally {
    await conn.close();
  }
}

/** DB 구조를 읽기만 한다 (DB 비교 화면용). 읽기 전용 연결, 모델 폴더와 맞추지 않는다 */
export async function readDb(ref: ConnRef): Promise<{ model: SchemaModel; warnings: string[] }> {
  const { conn, adapter, target } = await connectRef(ref, true);
  try {
    const schema = adapter.defaultSchema(target);
    const raw = await adapter.reverse(conn, schema);
    return { model: { version: MODEL_VERSION, dialect: adapter.dialect, schema, groups: [], common: [], tables: raw.tables, sequences: raw.sequences, functions: raw.functions }, warnings: raw.warnings };
  } finally {
    await conn.close();
  }
}
