// 통합 시험 (STEP 9): MySQL 어댑터. 도커 erd-mysql (WSL) 이 떠 있지 않으면 건너뛴다.
// 시험 스키마(test/fixtures/seed-mysql.sql)를 erdtest 에 다시 넣는다. DDL 이 바로 커밋되므로
// 전체 CREATE 와 ALTER 는 root 로 따로 만든 erd_scratch DB 에서 시험한 뒤 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mysqlAdapter } from '../../src/main/db/adapters/mysql';
import type { DbConn, Target } from '../../src/main/db/adapters/types';
import { allowWrite, closeSession, commitTx, fetchMore, openSession, rollbackTx, runSql } from '../../src/main/db/session';
import { loadModel, saveModel } from '../../src/main/model-store';
import { rulesFor } from '../../src/shared/dialect';
import { addColumn, addFk, updateColumn, updateTable } from '../../src/shared/model/edit';
import { diffModels } from '../../src/shared/model/diff';
import { emptyLayout } from '../../src/shared/model/layout';
import type { SchemaModel } from '../../src/shared/model/types';
import { buildAlter } from '../../src/shared/sql/alter';
import { buildCreateAll } from '../../src/shared/sql/create';
import { splitStatements } from '../../src/shared/sql/text';

const T: Target = { dialect: 'mysql', host: '127.0.0.1', port: 3306, database: 'erdtest', user: 'erd', password: 'test-password', readOnly: false };
const ROOT: Target = { ...T, user: 'root' };
const SCRATCH = 'erd_scratch';

let skip = '';
try {
  const c = await mysqlAdapter.connect(T, false);
  await c.close();
} catch (e) { skip = (e as Error).message; }
if (skip) console.warn(`MySQL 통합 시험을 건너뛴다: ${skip}`);

async function run(c: DbConn, sql: string) {
  for (const s of splitStatements(sql, rulesFor('mysql').text)) {
    const body = s.text.replace(/^(\s*--[^\n]*\n)+/, '').trim();
    if (body && !body.startsWith('--')) await c.exec(body);
  }
}

async function read(c: DbConn, schema: string): Promise<SchemaModel> {
  const r = await mysqlAdapter.reverse(c, schema);
  return { version: 2, dialect: 'mysql', schema, groups: [], common: [], sequences: r.sequences, functions: r.functions, tables: r.tables };
}

const differences = (a: SchemaModel, b: SchemaModel) => diffModels(a, b).map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}: ${i.detail}`);

describe.skipIf(!!skip)('MySQL 어댑터 (도커 erdtest)', () => {
  let c: DbConn;
  beforeAll(async () => {
    c = await mysqlAdapter.connect(T, false);
    await run(c, fs.readFileSync(path.join(__dirname, '../fixtures/seed-mysql.sql'), 'utf8'));
  });
  afterAll(async () => { await c?.close(); });

  it('리버스한 모델을 저장 → 읽기 → 저장해도 바이트가 같고, 테이블 수와 FK 수가 직접 집계와 같다', async () => {
    const r = await mysqlAdapter.reverse(c, 'erdtest');
    const counts = await mysqlAdapter.count(c, 'erdtest');
    expect(r.tables.length).toBe(counts.tables);
    expect(r.tables.reduce((n, t) => n + t.fks.length, 0)).toBe(counts.fks);
    expect(counts).toEqual({ tables: 5, fks: 3 });
    expect(r.warnings).toContain('뷰 erd_v_order: 모델에 담지 않습니다');

    const cust = r.tables.find(t => t.name === 'erd_customer')!;
    expect(cust.comment).toBe('거래처');
    expect(cust.columns.map(x => [x.name, x.type, x.notNull, x.default ?? '', x.identity ?? '', x.comment ?? ''])).toEqual([
      ['cust_id', 'int', true, '', 'default', ''],
      ['cust_cd', 'varchar(20)', true, '', '', '거래처 코드'],
      ['cust_nm', 'varchar(100)', true, '', '', ''],
      ['grade', 'char(1)', true, "'A'", '', ''],
      ['reg_dt', 'datetime(3)', true, 'CURRENT_TIMESTAMP(3)', '', ''],
    ]);
    expect(cust.uniques).toEqual([{ name: 'uq_erd_customer_cd', columns: ['cust_cd'] }]);
    expect(cust.checks?.map(k => k.name)).toEqual(['ck_erd_customer_grade']);
    const item = r.tables.find(t => t.name === 'erd_order_item')!;
    expect(item.pk).toEqual(['order_no', 'order_seq', 'item_no']);
    expect(item.fks.find(f => f.name === 'fk_erd_item_order')).toEqual({ name: 'fk_erd_item_order', columns: ['order_no', 'order_seq'], refTable: 'erd_order', refColumns: ['order_no', 'order_seq'], onDelete: 'cascade' });
    expect(item.columns.find(x => x.name === 'qty2')?.generated).toBe('`qty` * 2');
    expect(r.tables.find(t => t.name === 'erd_order')!.columns.find(x => x.name === 'amount')?.default).toBe('0.00');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-mysql-'));
    const model = await read(c, 'erdtest');
    model.tables.forEach((t, i) => (t.id = `t${i + 1}`));
    model.groups = [{ name: 'erd', isDefault: true }];
    await saveModel(dir, model, emptyLayout());
    const before = fs.readFileSync(path.join(dir, 'tables.erd'), 'utf8');
    const loaded = await loadModel(dir);
    expect(loaded.errors).toEqual([]);
    expect([loaded.model.dialect, loaded.model.schema]).toEqual(['mysql', 'erdtest']);
    const again = await saveModel(dir, loaded.model, loaded.layout);
    expect(again.written).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'tables.erd'), 'utf8')).toBe(before);
  }, 60_000);

  it('자동완성 목록: 테이블, 뷰, 컬럼 타입과 코멘트', async () => {
    const cat = await mysqlAdapter.catalog(c);
    expect(cat.dialect).toBe('mysql');
    const cust = cat.tables.find(t => t.name === 'erd_customer')!;
    expect([cust.kind, cust.schema, cust.comment]).toEqual(['table', 'erdtest', '거래처']);
    expect(cust.columns.find(x => x.name === 'cust_cd')).toEqual({ name: 'cust_cd', type: 'varchar(20)', comment: '거래처 코드' });
    expect(cat.tables.find(t => t.name === 'erd_v_order')).toMatchObject({ kind: 'view', comment: '' });
  });

  it('전체 CREATE 를 빈 DB 에 실행하고 다시 읽으면 차이 0, 화면 수정 ALTER 를 적용해도 차이 0', async () => {
    const model = await read(c, 'erdtest');
    const root = await mysqlAdapter.connect(ROOT, false);
    try {
      await root.exec(`DROP DATABASE IF EXISTS ${SCRATCH}`);
      await root.exec(`CREATE DATABASE ${SCRATCH} CHARACTER SET utf8mb4`);
      await root.exec(`USE ${SCRATCH}`);
      const target: SchemaModel = { ...model, schema: SCRATCH };
      await run(root, buildCreateAll(target).sql);
      expect(differences(await read(root, SCRATCH), target)).toEqual([]);

      let edited = addColumn(target, 'erd_product', { name: 'sort_no', type: 'integer', notNull: true, default: '0', comment: '정렬 순서' });
      edited = updateColumn(edited, 'erd_product', 'prod_nm', { type: 'varchar(300)' });
      edited = updateColumn(edited, 'erd_customer', 'grade', { default: "'B'", comment: '등급' });
      edited = updateColumn(edited, 'erd_order', 'amount', { type: 'decimal(14,2)', default: '0.00' });
      edited = updateTable(edited, 'erd_code', { comment: '공통 코드' });
      edited = addColumn(edited, 'erd_code', { name: 'prod_cd', type: 'varchar(20)', notNull: false });
      edited = addFk(edited, 'erd_code', { name: 'fk_erd_code_prod', columns: ['prod_cd'], refTable: 'erd_product', refColumns: ['prod_cd'], onDelete: 'restrict' });
      await run(root, buildAlter(target, edited).sql);
      const after = await read(root, SCRATCH);
      // MySQL 은 FK 에 쓸 인덱스가 없으면 FK 이름으로 인덱스를 만든다 (모델에는 인덱스로 읽힌다)
      expect(after.tables.find(t => t.name === 'erd_code')!.indexes.map(i => i.name)).toEqual(['fk_erd_code_prod']);
      after.tables.find(t => t.name === 'erd_code')!.indexes = [];
      expect(differences(after, edited)).toEqual([]);

      await run(root, buildAlter(edited, target).sql);
      const back = await read(root, SCRATCH);
      back.tables.find(t => t.name === 'erd_code')!.indexes = []; // FK 를 지워도 MySQL 이 만든 인덱스는 남는다
      expect(differences(back, target)).toEqual([]);
    } finally {
      await root.exec(`DROP DATABASE IF EXISTS ${SCRATCH}`).catch(() => {});
      await root.close();
    }
  }, 120_000);

  it('세션: 2,500행 나눠 받기, 실패한 문장 뒤에도 트랜잭션 유지, 롤백, 읽기 전용', async () => {
    const ref = { source: 'manual' as const, id: 'mysql-test' };
    await openSession('y1', ref, 'mysql', async () => T);
    await runSql('y1', 'SET SESSION cte_max_recursion_depth = 5000'); // 재귀 깊이 기본 1,000
    const r1 = await runSql('y1', 'WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 2500) SELECT n FROM g');
    expect(r1.error).toBeUndefined();
    expect([r1.rows.length, r1.state.more, r1.state.dialect, r1.state.readOnlyByAccount]).toEqual([1000, true, 'mysql', undefined]);
    const r2 = await fetchMore('y1');
    const r3 = await fetchMore('y1');
    expect([r2.rows.length, r3.rows.length, r3.state.more, String(r3.rows[499][0])]).toEqual([1000, 500, false, '2500']);

    await runSql('y1', "INSERT INTO erd_code (grp_cd, cd, cd_nm) VALUES ('G', 'C1', 'before')");
    const bad = await runSql('y1', 'SELECT * FROM no_such_table_erd');
    expect(bad.error?.code).toBe('ER_NO_SUCH_TABLE');
    expect((await runSql('y1', "SELECT cd_nm FROM erd_code WHERE grp_cd = 'G'")).rows).toEqual([['before']]);
    await rollbackTx('y1');
    expect((await runSql('y1', "SELECT COUNT(*) FROM erd_code WHERE grp_cd = 'G'")).rows).toEqual([['0']]); // BIGINT 는 글자로 받는다
    await commitTx('y1');
    await closeSession('y1');

    // 큰 결과를 다 받기 전에 다음 문장을 실행하면 앞 문장만 멈추고(KILL QUERY) 트랜잭션은 남는다
    await openSession('y3', ref, 'mysql', async () => T);
    await runSql('y3', 'SET SESSION cte_max_recursion_depth = 5000');
    await runSql('y3', "INSERT INTO erd_code (grp_cd, cd, cd_nm) VALUES ('K', 'K1', 'kept')");
    const big = await runSql('y3', 'WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 2000) SELECT a.n, b.n m, LPAD(a.n, 200, 0) pad FROM g a CROSS JOIN g b');
    expect([big.rows.length, big.state.more]).toEqual([1000, true]);
    const t0 = Date.now();
    const next = await runSql('y3', "SELECT cd_nm FROM erd_code WHERE grp_cd = 'K'");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect([next.rows, next.state.inTx]).toEqual([[['kept']], true]);
    await rollbackTx('y3');
    await closeSession('y3');

    // 읽기 전용 접속은 서버가 쓰기와 DDL 을 막고, 쓰기 허용 뒤에는 된다
    await openSession('y2', ref, 'mysql ro', async () => ({ ...T, readOnly: true }));
    expect((await runSql('y2', "INSERT INTO erd_code (grp_cd, cd) VALUES ('R', 'R1')")).error?.code).toBe('ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION');
    expect((await runSql('y2', 'CREATE TABLE erd_ro_probe (id int)')).error?.code).toBe('ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION');
    await allowWrite('y2');
    expect((await runSql('y2', "INSERT INTO erd_code (grp_cd, cd) VALUES ('R', 'R1')")).error).toBeUndefined();
    await rollbackTx('y2');
    await closeSession('y2');
  }, 60_000);
});
