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
import { countPg, reversePg } from './pg-reverse';
import { getProfile, passwordOf } from './profiles';

interface Target { host: string; port: number; database: string; user: string; password: string }

/** 접속 정보를 BE properties 또는 직접 입력 목록에서 찾는다. 비밀번호는 여기서만 다룬다 */
async function resolve(ref: ConnRef): Promise<Target> {
  if (ref.source === 'be') {
    const p = getProfile(ref.beDir, ref.name);
    return { host: p.host, port: p.port, database: p.database, user: p.user, password: passwordOf(p, ref.beDir) };
  }
  // electron 모듈을 쓰므로 직접 입력일 때만 불러온다 (BE 통합 시험은 Electron 밖에서 돈다)
  const { resolveManual } = await import('./manual');
  const { conn, password } = await resolveManual(ref.id);
  return { ...conn, password };
}

async function connect(t: Target): Promise<pg.Client> {
  const client = new pg.Client({ ...t, connectionTimeoutMillis: 10_000, application_name: 'erd-tool' });
  await client.connect();
  // 리버스와 접속 시험은 읽기만 한다
  await client.query('set default_transaction_read_only = on');
  return client;
}

export const testConnection = async (ref: ConnRef) => test(() => resolve(ref));
export const testDraft = async (c: ManualConn, password: string) => test(async () => ({ ...c, password }));

async function test(target: () => Promise<Target>): Promise<ConnTestResult> {
  let client: pg.Client | undefined;
  try {
    client = await connect(await target());
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
  const client = await connect(await resolve(ref));
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
    return { model, diff, warnings: raw.warnings, counts, hadModel: !!prev, layout: loaded?.layout ?? emptyLayout() };
  } finally {
    await client.end().catch(() => {});
  }
}
