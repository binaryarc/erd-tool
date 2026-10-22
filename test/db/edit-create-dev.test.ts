// 통합 시험 (STEP 6): 모델 전체 CREATE 와 화면 수정 명령으로 만든 ALTER 를 dev 에 실제로 적용해 본다.
// 한 트랜잭션 안에서 시험 스키마 erd_tmp 를 만들고 끝에 롤백하므로 dev 에는 아무것도 남지 않는다.
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePgSample } from '../helpers/pg-sample';
import { connect, resolve } from '../../src/main/db/connect';
import { getProfile, passwordOf } from '../../src/main/db/profiles';
import { postgresAdapter } from '../../src/main/db/adapters/postgres';
import type { DbConn } from '../../src/main/db/adapters/types';
import { diffModels } from '../../src/shared/model/diff';
import { addColumn, addFk, addTable, updateColumn } from '../../src/shared/model/edit';
import { buildAlter } from '../../src/shared/sql/alter';
import { buildCreateAll } from '../../src/shared/sql/create';
import { splitStatements } from '../../src/shared/sql/text';
import type { SchemaModel } from '../../src/shared/model/types';

const BE = process.env.ERD_BE_DIR ?? ''; // test/.env.local 에서 읽는다. 없으면 아래에서 건너뛴다
let skip = '';
try { passwordOf(getProfile(BE, 'dev'), BE); } catch (e) { skip = (e as Error).message; }

async function run(client: DbConn, sql: string) {
  for (const s of splitStatements(sql)) {
    const body = s.text.replace(/^(--[^\n]*\n)+/, '').trim();
    if (body) await client.exec(body);
  }
}

/** 함수는 정의에 public 스키마가 박혀 있어(pg_get_functiondef) 시험 스키마에 만들 수 없다. 테이블과 시퀀스만 비교한다 */
async function read(client: DbConn, like: SchemaModel): Promise<SchemaModel> {
  const r = await postgresAdapter.reverse(client, 'erd_tmp');
  return { ...like, tables: r.tables, sequences: r.sequences, functions: [] };
}
const differences = (a: SchemaModel, b: SchemaModel) => diffModels(a, b).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}: ${d.detail}`);

describe.skipIf(!!skip)('STEP 6 dev 실제 적용', () => {
  beforeAll(() => ensurePgSample(BE), 60_000); // 예시 스키마(test/fixtures/seed-postgres.sql)가 없으면 넣는다
  it('모델 전체 CREATE 를 빈 스키마에 실행하고 다시 읽으면 모델과 차이 0, 화면 수정 ALTER 도 차이 0 (끝에 롤백)', async () => {
    const client = await connect(await resolve({ source: 'be', beDir: BE, name: 'dev' }), false);
    try {
      // 모델은 시험 DB 의 예시 스키마(public)를 읽어 만든다
      const pub = await postgresAdapter.reverse(client, 'public');
      const model: SchemaModel = { version: 1, groups: [], common: [], tables: pub.tables, sequences: pub.sequences, functions: [] };
      await client.exec('BEGIN');
      await client.exec('CREATE SCHEMA erd_tmp');
      await client.exec('SET LOCAL search_path TO erd_tmp');

      const create = buildCreateAll(model, { functions: false });
      await run(client, create.sql);
      const created = await read(client, model);
      expect(differences(created, model)).toEqual([]);
      expect(created.tables.length).toBe(model.tables.length);

      // 화면에서 하는 것과 같은 명령: 새 테이블, 컬럼 추가, FK, 기존 테이블에 컬럼 추가와 코멘트
      let edited = addTable(created, 'mst_erd_probe', { comment: '시험 테이블', withCommon: true });
      edited = addColumn(edited, 'mst_erd_probe', { name: 'probe_seq', type: 'int', notNull: false, pk: true });
      edited = addColumn(edited, 'mst_erd_probe', { name: 'brand_seq', type: 'INTEGER', notNull: false, comment: '사업장' });
      edited = addFk(edited, 'mst_erd_probe', { name: 'fk_mst_erd_probe_mst_brand', columns: ['brand_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] });
      edited = addColumn(edited, 'mst_brand', { name: 'erd_sort_no', type: 'integer', notNull: true, default: '0' });
      edited = updateColumn(edited, 'mst_brand', 'brand_nm', { comment: '사업장 이름 (시험)' });
      const alter = buildAlter(created, edited);
      await run(client, alter.sql);
      expect(differences(await read(client, model), edited)).toEqual([]);
      console.log(JSON.stringify({ createStatements: create.statements, tables: model.tables.length, alterStatements: alter.statements }));
    } finally {
      await client.exec('ROLLBACK').catch(() => {});
      const left = await client.query("select count(*)::int n from pg_namespace where nspname = 'erd_tmp'");
      expect(left[0].n).toBe(0); // dev 에 남은 것 없음
      await client.close();
    }
  }, 120_000);
});
