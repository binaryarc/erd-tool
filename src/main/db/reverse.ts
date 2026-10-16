// 접속 시험과 리버스: 프로필로 접속 → 카탈로그 읽기 → 기존 모델에 맞춰 ID 유지 → 차이 목록 (저장은 하지 않는다)

import fs from 'node:fs';
import path from 'node:path';
import { detectCommon, groupsFromErdGroupsJson } from '../../shared/model/groups';
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
    return { ok: true, message: `${v.database} 접속 성공`, tables: c.tables, fks: c.fks, server: v.version };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  } finally {
    await conn?.close();
  }
}

/** 허브 docs-hub/spec/{BE 이름에서 -be 뗀 값}/_knowledge/.../erd-groups.json */
function hubGroups(beDir: string): GroupRule[] | null {
  const project = path.basename(beDir).replace(/-be$/, '');
  const file = path.join(path.dirname(beDir), 'docs-hub', 'spec', project, '_knowledge',
    'patterns', '20-database', '40-schema', 'erd-groups.json');
  if (!fs.existsSync(file)) return null;
  return groupsFromErdGroupsJson(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** hubBeDir: 그룹 규칙(erd-groups.json)을 찾을 BE 폴더. BE 프로필이면 그 폴더, 직접 입력이면 설정의 BE 폴더(없어도 됨) */
export async function reverse(ref: ConnRef, modelDir: string, hubBeDir?: string): Promise<ReverseResult> {
  const beDir = ref.source === 'be' ? ref.beDir : hubBeDir;
  const loaded = fs.existsSync(path.join(modelDir, '_index.erd')) ? await loadModel(modelDir) : null;
  const prev = loaded?.model ?? null;
  const { conn, adapter, target } = await connectRef(ref, true);
  try {
    // 다른 DB 종류의 모델 폴더에 덮어쓰지 않는다
    if (prev && (prev.dialect ?? 'postgresql') !== adapter.dialect) {
      throw new Error(`모델 폴더는 ${DIALECT_LABEL[prev.dialect ?? 'postgresql']} 모델이다. ${DIALECT_LABEL[adapter.dialect]} 접속은 다른 폴더로 불러온다`);
    }
    const schema = adapter.defaultSchema(target);
    const raw = await adapter.reverse(conn, schema);
    const counts = await adapter.count(conn, schema);
    const next: SchemaModel = {
      version: MODEL_VERSION,
      dialect: adapter.dialect,
      schema,
      groups: prev?.groups.length ? prev.groups : ((beDir && hubGroups(beDir)) || [{ name: 'main', isDefault: true }]),
      common: prev?.common.length ? prev.common : detectCommon(raw.tables),
      sequences: raw.sequences,
      tables: raw.tables,
      functions: raw.functions,
    };
    const { model, diff } = mergeModel(prev, next);
    return { model, diff, warnings: raw.warnings, counts, hadModel: !!prev, layout: loaded?.layout ?? emptyLayout(), prev };
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
