// 접속 시험과 리버스: 프로필로 접속 → 카탈로그 읽기 → 기존 모델에 맞춰 ID 유지 → 차이 목록 (저장은 하지 않는다)

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { detectCommon, groupsFromErdGroupsJson } from '../../shared/model/groups';
import { mergeModel } from '../../shared/model/merge';
import { emptyLayout } from '../../shared/model/layout';
import { MODEL_VERSION, type GroupRule, type SchemaModel } from '../../shared/model/types';
import type { ConnRef, ConnTestResult, ManualConn, ReverseResult } from '../../shared/ipc';
import { loadModel } from '../model-store';
import { connect, resolve, type Target } from './connect';
import { countPg, reversePg } from './pg-reverse';

export const testConnection = async (ref: ConnRef) => test(() => resolve(ref));
export const testDraft = async (c: ManualConn, password: string) => test(async () => ({ ...c, password }));

async function test(target: () => Promise<Target>): Promise<ConnTestResult> {
  let client: pg.Client | undefined;
  try {
    // 리버스와 접속 시험은 읽기만 한다
    client = await connect(await target(), true);
    const c = await countPg(client);
    const v = await client.query('select current_database() db, version() ver');
    return { ok: true, message: `${v.rows[0].db} 접속 성공`, tables: c.tables, fks: c.fks, server: String(v.rows[0].ver).split(',')[0] };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  } finally {
    await client?.end().catch(() => {});
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
  const client = await connect(await resolve(ref), true);
  try {
    const raw = await reversePg(client);
    const counts = await countPg(client);
    const next: SchemaModel = {
      version: MODEL_VERSION,
      groups: prev?.groups.length ? prev.groups : ((beDir && hubGroups(beDir)) || [{ name: 'main', isDefault: true }]),
      common: prev?.common.length ? prev.common : detectCommon(raw.tables),
      sequences: raw.sequences,
      tables: raw.tables,
      functions: raw.functions,
    };
    const { model, diff } = mergeModel(prev, next);
    return { model, diff, warnings: raw.warnings, counts, hadModel: !!prev, layout: loaded?.layout ?? emptyLayout(), prev };
  } finally {
    await client.end().catch(() => {});
  }
}

/** DB 구조를 읽기만 한다 (DB 비교 화면용). 읽기 전용 연결, 모델 폴더와 맞추지 않는다 */
export async function readDb(ref: ConnRef): Promise<{ model: SchemaModel; warnings: string[] }> {
  const client = await connect(await resolve(ref), true);
  try {
    const raw = await reversePg(client);
    return { model: { version: MODEL_VERSION, groups: [], common: [], tables: raw.tables, sequences: raw.sequences, functions: raw.functions }, warnings: raw.warnings };
  } finally {
    await client.end().catch(() => {});
  }
}
