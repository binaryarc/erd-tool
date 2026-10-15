// 접속 시험과 리버스: 프로필로 접속 → 카탈로그 읽기 → 기존 모델에 맞춰 ID 유지 → 차이 목록 (저장은 하지 않는다)

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { detectCommon, groupsFromErdGroupsJson } from '../../shared/model/groups';
import { mergeModel } from '../../shared/model/merge';
import { MODEL_VERSION, type GroupRule, type SchemaModel } from '../../shared/model/types';
import type { ConnTestResult, ReverseResult } from '../../shared/ipc';
import { loadModel } from '../model-store';
import { countPg, reversePg } from './pg-reverse';
import { getProfile, passwordOf } from './profiles';

async function connect(beDir: string, profile: string): Promise<pg.Client> {
  const p = getProfile(beDir, profile);
  const client = new pg.Client({
    host: p.host, port: p.port, database: p.database, user: p.user, password: passwordOf(p, beDir),
    connectionTimeoutMillis: 10_000, application_name: 'erd-tool',
  });
  await client.connect();
  // 리버스는 읽기만 한다
  await client.query('set default_transaction_read_only = on');
  return client;
}

export async function testConnection(beDir: string, profile: string): Promise<ConnTestResult> {
  let client: pg.Client | undefined;
  try {
    client = await connect(beDir, profile);
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

export async function reverse(beDir: string, profile: string, modelDir: string): Promise<ReverseResult> {
  const prev = fs.existsSync(path.join(modelDir, '_index.erd')) ? (await loadModel(modelDir)).model : null;
  const client = await connect(beDir, profile);
  try {
    const raw = await reversePg(client);
    const counts = await countPg(client);
    const next: SchemaModel = {
      version: MODEL_VERSION,
      groups: prev?.groups.length ? prev.groups : (hubGroups(beDir) ?? [{ name: 'main', isDefault: true }]),
      common: prev?.common.length ? prev.common : detectCommon(raw.tables),
      sequences: raw.sequences,
      tables: raw.tables,
      functions: raw.functions,
    };
    const { model, diff } = mergeModel(prev, next);
    return { model, diff, warnings: raw.warnings, counts, hadModel: !!prev };
  } finally {
    await client.end().catch(() => {});
  }
}
