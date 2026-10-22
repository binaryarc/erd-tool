// 통합 시험: 만든 ALTER 를 dev 에 실제로 적용해 본다 (STEP 5 완료 기준 2).
// 한 트랜잭션 안에서 시험 스키마 erd_tmp 를 만들고 끝에 롤백하므로 dev 에는 아무것도 남지 않는다.
import { describe, expect, it } from 'vitest';
import { connect, resolve } from '../../src/main/db/connect';
import { getProfile, passwordOf } from '../../src/main/db/profiles';
import { postgresAdapter } from '../../src/main/db/adapters/postgres';
import type { DbConn } from '../../src/main/db/adapters/types';
import { diffModels } from '../../src/shared/model/diff';
import { buildAlter } from '../../src/shared/sql/alter';
import { updateColumn, updateTable } from '../../src/shared/model/edit';
import { splitStatements } from '../../src/shared/sql/text';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';

const BE = process.env.ERD_BE_DIR ?? ''; // test/.env.local 에서 읽는다. 없으면 아래에서 건너뛴다
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
  table('erd_brand', [col('brand_seq', 'integer', { notNull: true, comment: '사업장 SEQ' }), col('brand_nm', 'varchar(100)'), col('memo', 'text'),
    col('use_yn', 'char(1)', { notNull: true, default: "'Y'::bpchar" })], { pk: ['brand_seq'], comment: '사업장' }),
  table('erd_wh', [col('wh_seq', 'integer', { notNull: true }), col('brand_seq', 'integer')], {
    pk: ['wh_seq'], fks: [{ name: 'fk_wh_brand', columns: ['brand_seq'], refTable: 'erd_brand', refColumns: ['brand_seq'] }],
    indexes: [{ name: 'ix_wh_brand', columns: ['brand_seq'], unique: false }],
  }),
  table('erd_old', [col('id', 'integer', { notNull: true })], { pk: ['id'] }),
]);
const B = model([
  table('erd_brand', [col('brand_seq', 'integer', { notNull: true, comment: '사업장 SEQ' }), col('brand_nm', 'varchar(50)', { notNull: true }),
    col('use_yn', 'char(1)', { notNull: true, default: "'N'::bpchar" }), col('sort_no', 'integer', { default: '0' })], { pk: ['brand_seq'], comment: '사업장 마스터' }),
  table('erd_wh', [col('wh_seq', 'integer', { notNull: true }), col('brand_seq', 'integer', { notNull: true })], {
    pk: ['wh_seq', 'brand_seq'], fks: [{ name: 'fk_wh_brand', columns: ['brand_seq'], refTable: 'erd_brand', refColumns: ['brand_seq'] }],
    uniques: [{ name: 'uq_wh_brand', columns: ['brand_seq', 'wh_seq'] }],
  }),
  table('erd_center', [col('center_seq', 'integer', { notNull: true, default: "nextval('erd_center_seq'::regclass)" }), col('brand_seq', 'integer')], {
    pk: ['center_seq'], comment: "센터's", fks: [{ name: 'fk_center_brand', columns: ['brand_seq'], refTable: 'erd_brand', refColumns: ['brand_seq'] }],
    indexes: [{ name: 'ix_center_lower', columns: ['brand_seq'], unique: true }],
  }),
], {
  sequences: [{ name: 'erd_center_seq', start: 1, inc: 1 }],
  functions: [{ name: 'erd_fn', args: 'a integer', definition: 'CREATE OR REPLACE FUNCTION erd_fn(a integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ select a + 1 $function$' }],
});

async function run(client: DbConn, sql: string) {
  for (const s of splitStatements(sql)) {
    const body = s.text.replace(/^(--[^\n]*\n)+/, '').trim();
    if (body) await client.exec(body);
  }
}

async function read(client: DbConn): Promise<SchemaModel> {
  const r = await postgresAdapter.reverse(client, 'erd_tmp');
  return model(r.tables, { sequences: r.sequences, functions: r.functions });
}

/** 함수 정의는 PostgreSQL 이 다시 써서 돌려주므로(스키마 붙임 등) 이름만 비교한다 */
const meaningful = (from: SchemaModel, to: SchemaModel) =>
  diffModels(from, to).filter(d => !(d.kind === 'function' && d.change === 'alter')).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}: ${d.detail}`);

describe.skipIf(!!skip)('ALTER 를 dev 에 실제로 적용', () => {
  it('A 를 만들고 A→B, B→A 를 적용한 뒤 다시 읽으면 각각 목표와 차이가 0 (끝에 롤백)', async () => {
    const client = await connect(await resolve({ source: 'be', beDir: BE, name: 'dev' }), false);
    try {
      await client.exec('BEGIN');
      await client.exec('CREATE SCHEMA erd_tmp');
      await client.exec('SET LOCAL search_path TO erd_tmp');

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
      await client.exec('ROLLBACK').catch(() => {});
      const left = await client.query("select count(*)::int n from pg_namespace where nspname = 'erd_tmp'");
      expect(left[0].n).toBe(0); // dev 에 남은 것 없음
      await client.close();
    }
  }, 60_000);

  it('identity, 생성 컬럼, CHECK 를 읽고 그대로 다시 만들며, 화면에서 바꾼 이름은 데이터를 지키는 RENAME 이다 (끝에 롤백)', async () => {
    const client = await connect(await resolve({ source: 'be', beDir: BE, name: 'dev' }), false);
    try {
      await client.exec('BEGIN');
      await client.exec('CREATE SCHEMA erd_tmp');
      await client.exec('SET LOCAL search_path TO erd_tmp');
      // 2026-10-16 화면 재현에 쓴 테이블과 같은 모양
      await client.exec('create table erd_probe_chk (id integer generated always as identity primary key, qty integer check (qty >= 0), qty2 integer generated always as (qty * 2) stored)');
      const r = await postgresAdapter.reverse(client, 'erd_tmp');
      const t = r.tables[0];
      expect(t.columns).toEqual([
        { name: 'id', type: 'integer', notNull: true, identity: 'always' },
        { name: 'qty', type: 'integer', notNull: false },
        { name: 'qty2', type: 'integer', notNull: false, generated: 'qty * 2' },
      ]);
      expect(t.checks).toEqual([{ name: 'erd_probe_chk_qty_check', definition: 'CHECK ((qty >= 0))' }]);
      expect(r.sequences).toEqual([]); // identity 가 만든 시퀀스는 따로 담지 않는다
      const m = model(r.tables);

      // 전체 CREATE 를 빈 스키마에 실행하고 다시 읽으면 차이 0 (전에는 생성식이 DEFAULT 로 나와 실행이 실패했다)
      await client.exec('DROP TABLE erd_probe_chk');
      await run(client, buildAlter(empty, m).sql);
      expect(meaningful(await read(client), m)).toEqual([]);

      // 이름 바꾸기: 행을 넣고 테이블, 컬럼 이름을 바꿔 적용하면 행이 남는다 (전에는 DROP 뒤 ADD 라 값이 사라졌다)
      await client.exec('insert into erd_probe_chk (qty) values (5)');
      let renamed = updateTable(m, 'erd_probe_chk', { name: 'erd_probe_renamed' });
      renamed = updateColumn(renamed, 'erd_probe_renamed', 'qty', { name: 'amount' });
      await run(client, buildAlter(m, renamed).sql);
      expect(meaningful(await read(client), renamed)).toEqual([]);
      expect((await client.query('select amount, qty2 from erd_probe_renamed'))).toEqual([{ amount: 5, qty2: 10 }]);
      // CHECK 는 새 이름으로 계속 막는다
      await client.exec('SAVEPOINT ck');
      await expect(client.exec('insert into erd_probe_renamed (amount) values (-1)')).rejects.toThrow(/check constraint/);
      await client.exec('ROLLBACK TO SAVEPOINT ck');
    } finally {
      await client.exec('ROLLBACK').catch(() => {});
      const left = await client.query("select count(*)::int n from pg_namespace where nspname = 'erd_tmp'");
      expect(left[0].n).toBe(0);
      await client.close();
    }
  }, 60_000);

  it('FK 참조 동작과 DEFERRABLE 을 읽고, 바꾼 ALTER 를 적용하면 다시 읽은 결과가 목표와 같다 (끝에 롤백)', async () => {
    const client = await connect(await resolve({ source: 'be', beDir: BE, name: 'dev' }), false);
    try {
      await client.exec('BEGIN');
      await client.exec('CREATE SCHEMA erd_tmp');
      await client.exec('SET LOCAL search_path TO erd_tmp');
      await client.exec('create table erd_p (id integer primary key)');
      await client.exec('create table erd_c (id integer primary key, p_id integer, constraint fk_c_p foreign key (p_id) references erd_p (id) on delete cascade deferrable initially deferred)');
      const m = await read(client);
      expect(m.tables.find(t => t.name === 'erd_c')!.fks).toEqual([
        { name: 'fk_c_p', columns: ['p_id'], refTable: 'erd_p', refColumns: ['id'], onDelete: 'cascade', deferrable: 'deferred' },
      ]);
      // dev 와 test 의 차이처럼 DEFERRABLE 만 뺀 모습으로 바꾼다
      const target = { ...m, tables: m.tables.map(t => (t.name === 'erd_c' ? { ...t, fks: [{ ...t.fks[0], deferrable: undefined }] } : t)) };
      delete target.tables.find(t => t.name === 'erd_c')!.fks[0].deferrable;
      await run(client, buildAlter(m, target).sql);
      expect(meaningful(await read(client), target)).toEqual([]);
      await run(client, buildAlter(target, m).sql);
      expect(meaningful(await read(client), m)).toEqual([]);
    } finally {
      await client.exec('ROLLBACK').catch(() => {});
      const left = await client.query("select count(*)::int n from pg_namespace where nspname = 'erd_tmp'");
      expect(left[0].n).toBe(0);
      await client.close();
    }
  }, 60_000);
});
