// 통합 시험: 만든 ALTER 를 dev 에 실제로 적용해 본다 (STEP 5 완료 기준 2).
// 한 트랜잭션 안에서 시험 스키마 erd_tmp 를 만들고 끝에 롤백하므로 dev 에는 아무것도 남지 않는다.
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { connect, resolve } from '../../src/main/db/connect';
import { getProfile, passwordOf } from '../../src/main/db/profiles';
import { reversePg } from '../../src/main/db/pg-reverse';
import { diffModels } from '../../src/shared/model/diff';
import { buildAlter } from '../../src/shared/sql/alter';
import { splitStatements } from '../../src/shared/sql/text';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const BE = process.env.ERD_BE_DIR ?? 'C:/work/workspace/shop-be';
let skip = '';
try { passwordOf(getProfile(BE, 'dev'), BE); } catch (e) { skip = (e as Error).message; }

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id: '', name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const model = (tables: Table[], extra: Partial<SchemaModel> = {}): SchemaModel =>
  ({ version: 1, groups: [], common: [], sequences: [], functions: [], tables, ...extra });
const empty = model([]);

// 기본값은 PostgreSQL 이 돌려주는 모양 그대로 적는다 (다시 읽었을 때 글자가 같아야 비교된다)
const A = model([
  table('erd_biz', [col('biz_seq', 'integer', { notNull: true, comment: '사업장 SEQ' }), col('biz_nm', 'varchar(100)'), col('memo', 'text'),
    col('use_yn', 'char(1)', { notNull: true, default: "'Y'::bpchar" })], { pk: ['biz_seq'], comment: '사업장' }),
  table('erd_wh', [col('wh_seq', 'integer', { notNull: true }), col('biz_seq', 'integer')], {
    pk: ['wh_seq'], fks: [{ name: 'fk_wh_biz', columns: ['biz_seq'], refTable: 'erd_biz', refColumns: ['biz_seq'] }],
    indexes: [{ name: 'ix_wh_biz', columns: ['biz_seq'], unique: false }],
  }),
  table('erd_old', [col('id', 'integer', { notNull: true })], { pk: ['id'] }),
]);
const B = model([
  table('erd_biz', [col('biz_seq', 'integer', { notNull: true, comment: '사업장 SEQ' }), col('biz_nm', 'varchar(50)', { notNull: true }),
    col('use_yn', 'char(1)', { notNull: true, default: "'N'::bpchar" }), col('sort_no', 'integer', { default: '0' })], { pk: ['biz_seq'], comment: '사업장 마스터' }),
  table('erd_wh', [col('wh_seq', 'integer', { notNull: true }), col('biz_seq', 'integer', { notNull: true })], {
    pk: ['wh_seq', 'biz_seq'], fks: [{ name: 'fk_wh_biz', columns: ['biz_seq'], refTable: 'erd_biz', refColumns: ['biz_seq'] }],
    uniques: [{ name: 'uq_wh_biz', columns: ['biz_seq', 'wh_seq'] }],
  }),
  table('erd_center', [col('center_seq', 'integer', { notNull: true, default: "nextval('erd_center_seq'::regclass)" }), col('biz_seq', 'integer')], {
    pk: ['center_seq'], comment: "센터's", fks: [{ name: 'fk_center_biz', columns: ['biz_seq'], refTable: 'erd_biz', refColumns: ['biz_seq'] }],
    indexes: [{ name: 'ix_center_lower', columns: ['biz_seq'], unique: true }],
  }),
], {
  sequences: [{ name: 'erd_center_seq', start: 1, inc: 1 }],
  functions: [{ name: 'erd_fn', args: 'a integer', definition: 'CREATE OR REPLACE FUNCTION erd_fn(a integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ select a + 1 $function$' }],
});

async function run(client: pg.Client, sql: string) {
  for (const s of splitStatements(sql)) {
    const body = s.text.replace(/^(--[^\n]*\n)+/, '').trim();
    if (body) await client.query(body);
  }
}

async function read(client: pg.Client): Promise<SchemaModel> {
  const r = await reversePg(client, { schema: 'erd_tmp' });
  return model(r.tables, { sequences: r.sequences, functions: r.functions });
}

/** 함수 정의는 PostgreSQL 이 다시 써서 돌려주므로(스키마 붙임 등) 이름만 비교한다 */
const meaningful = (from: SchemaModel, to: SchemaModel) =>
  diffModels(from, to).filter(d => !(d.kind === 'function' && d.change === 'alter')).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}: ${d.detail}`);

describe.skipIf(!!skip)('ALTER 를 dev 에 실제로 적용', () => {
  it('A 를 만들고 A→B, B→A 를 적용한 뒤 다시 읽으면 각각 목표와 차이가 0 (끝에 롤백)', async () => {
    const client = await connect(await resolve({ source: 'be', beDir: BE, name: 'dev' }), false);
    try {
      await client.query('BEGIN');
      await client.query('CREATE SCHEMA erd_tmp');
      await client.query('SET LOCAL search_path TO erd_tmp');

      await run(client, buildAlter(empty, A).sql);
      expect(meaningful(await read(client), A)).toEqual([]);

      const ab = buildAlter(A, B);
      await run(client, ab.sql);
      expect(meaningful(await read(client), B)).toEqual([]);
      expect((await read(client)).functions.map(f => f.name)).toEqual(['erd_fn']);

      const ba = buildAlter(B, A);
      await run(client, ba.sql);
      expect(meaningful(await read(client), A)).toEqual([]);
      console.log(JSON.stringify({ abStatements: ab.statements, abDangers: ab.dangers, baStatements: ba.statements, baDangers: ba.dangers }));
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      const left = await client.query("select count(*)::int n from pg_namespace where nspname = 'erd_tmp'");
      expect(left.rows[0].n).toBe(0); // dev 에 남은 것 없음
      await client.end();
    }
  }, 60_000);
});
