// 통합 시험 (STEP 9): SQL Server 어댑터. 도커 erd-mssql (WSL) 이 떠 있지 않으면 건너뛴다.
// 시험 스키마(test/fixtures/seed-mssql.sql)를 erdtest 에 다시 넣고, 전체 CREATE 와 ALTER 는 따로 만든 erd_scratch DB 에서 시험한 뒤 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mssqlAdapter } from '../../src/main/db/adapters/mssql';
import type { DbConn, Target } from '../../src/main/db/adapters/types';
import { closeSession, commitTx, fetchMore, openSession, rollbackTx, runSql } from '../../src/main/db/session';
import { loadModel, saveModel } from '../../src/main/model-store';
import { rulesFor } from '../../src/shared/dialect';
import { addColumn, addFk, updateColumn, updateTable } from '../../src/shared/model/edit';
import { diffModels } from '../../src/shared/model/diff';
import { emptyLayout } from '../../src/shared/model/layout';
import type { SchemaModel } from '../../src/shared/model/types';
import { buildAlter } from '../../src/shared/sql/alter';
import { buildCreateAll } from '../../src/shared/sql/create';
import { splitStatements } from '../../src/shared/sql/text';

const T: Target = { dialect: 'sqlserver', host: '127.0.0.1', port: 1433, database: 'erdtest', user: 'sa', password: 'test-password', readOnly: false, trustCert: true };
const SCRATCH = 'erd_scratch';

let skip = '';
try {
  const c = await mssqlAdapter.connect(T, false);
  await c.close();
} catch (e) { skip = (e as Error).message; }
if (skip) console.warn(`SQL Server 통합 시험을 건너뛴다: ${skip}`);

/** 스크립트를 문장으로 나눠 차례로 실행한다 (앞 주석 줄은 뗀다) */
async function run(c: DbConn, sql: string) {
  for (const s of splitStatements(sql, rulesFor('sqlserver').text)) {
    const body = s.text.replace(/^(\s*--[^\n]*\n)+/, '').trim();
    if (body && !body.startsWith('--')) await c.exec(body);
  }
}

async function read(c: DbConn): Promise<SchemaModel> {
  const r = await mssqlAdapter.reverse(c, 'dbo');
  return { version: 2, dialect: 'sqlserver', schema: 'dbo', groups: [], common: [], sequences: r.sequences, functions: r.functions, tables: r.tables };
}

const differences = (a: SchemaModel, b: SchemaModel) => diffModels(a, b).map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}: ${i.detail}`);

describe.skipIf(!!skip)('SQL Server 어댑터 (도커 erdtest)', () => {
  let c: DbConn;
  beforeAll(async () => {
    c = await mssqlAdapter.connect(T, false);
    await run(c, fs.readFileSync(path.join(__dirname, '../fixtures/seed-mssql.sql'), 'utf8'));
  });
  afterAll(async () => {
    await c?.exec(`IF DB_ID('${SCRATCH}') IS NOT NULL BEGIN ALTER DATABASE ${SCRATCH} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${SCRATCH}; END`).catch(() => {});
    await c?.close();
  });

  it('리버스한 모델을 저장 → 읽기 → 저장해도 바이트가 같고, 테이블 수와 FK 수가 직접 집계와 같다', async () => {
    const r = await mssqlAdapter.reverse(c, 'dbo');
    const counts = await mssqlAdapter.count(c, 'dbo');
    expect(r.tables.length).toBe(counts.tables);
    expect(r.tables.reduce((n, t) => n + t.fks.length, 0)).toBe(counts.fks);
    expect(counts).toEqual({ tables: 5, fks: 3 });
    expect(r.warnings).toContain('뷰 erd_v_order: 모델에 담지 않는다');

    const cust = r.tables.find(t => t.name === 'erd_customer')!;
    expect(cust.comment).toBe('거래처');
    expect(cust.columns.map(x => [x.name, x.type, x.notNull, x.default ?? '', x.identity ?? '', x.comment ?? ''])).toEqual([
      ['cust_id', 'int', true, '', 'always', ''],
      ['cust_cd', 'varchar(20)', true, '', '', '거래처 코드'],
      ['cust_nm', 'nvarchar(100)', true, '', '', ''],
      ['grade', 'char(1)', true, "('A')", '', ''],
      ['reg_dt', 'datetime2(3)', true, '(sysdatetime())', '', ''],
    ]);
    expect(cust.uniques).toEqual([{ name: 'uq_erd_customer_cd', columns: ['cust_cd'] }]);
    expect(cust.checks).toEqual([{ name: 'ck_erd_customer_grade', definition: "CHECK ([grade]='C' OR [grade]='B' OR [grade]='A')" }]);
    const item = r.tables.find(t => t.name === 'erd_order_item')!;
    expect(item.pk).toEqual(['order_no', 'order_seq', 'item_no']);
    expect(item.fks.find(f => f.name === 'fk_erd_item_order')).toEqual({ name: 'fk_erd_item_order', columns: ['order_no', 'order_seq'], refTable: 'erd_order', refColumns: ['order_no', 'order_seq'], onDelete: 'cascade' });
    expect(item.columns.find(x => x.name === 'qty2')?.generated).toBe('[qty]*(2)');
    expect(r.tables.find(t => t.name === 'erd_order')!.indexes).toEqual([{ name: 'ix_erd_order_cust', columns: ['cust_id', 'order_dt'], unique: false }]);
    expect(r.sequences).toEqual([{ name: 'erd_seq', start: 100, inc: 10 }]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-mssql-'));
    const model = await read(c);
    model.tables.forEach((t, i) => (t.id = `t${i + 1}`));
    model.groups = [{ name: 'erd', isDefault: true }];
    await saveModel(dir, model, emptyLayout());
    const before = fs.readFileSync(path.join(dir, 'erd.erd'), 'utf8');
    const loaded = await loadModel(dir);
    expect(loaded.errors).toEqual([]);
    expect([loaded.model.dialect, loaded.model.schema]).toEqual(['sqlserver', 'dbo']);
    const again = await saveModel(dir, loaded.model, loaded.layout);
    expect(again.written).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'erd.erd'), 'utf8')).toBe(before);
  }, 60_000);

  it('전체 CREATE 를 빈 DB 에 실행하고 다시 읽으면 차이 0, 화면 수정 ALTER 를 적용해도 차이 0', async () => {
    const model = await read(c);
    await c.exec(`IF DB_ID('${SCRATCH}') IS NULL CREATE DATABASE ${SCRATCH}`);
    const s = await mssqlAdapter.connect({ ...T, database: SCRATCH }, false);
    try {
      await run(s, buildCreateAll(model).sql);
      expect(differences(await read(s), model)).toEqual([]);

      // 컬럼 추가(코멘트, 기본값), 타입과 NULL 바꾸기, 기본값 바꾸기, 코멘트 바꾸기, 테이블 코멘트, 새 FK
      let edited = addColumn(model, 'erd_product', { name: 'sort_no', type: 'integer', notNull: true, default: '((0))', comment: '정렬 순서' });
      edited = updateColumn(edited, 'erd_product', 'prod_nm', { type: 'nvarchar(300)' });
      edited = updateColumn(edited, 'erd_customer', 'grade', { default: "('B')", comment: '등급' });
      edited = updateColumn(edited, 'erd_order', 'amount', { type: 'decimal(14,2)' });
      edited = updateTable(edited, 'erd_code', { comment: '공통 코드' });
      edited = addColumn(edited, 'erd_code', { name: 'prod_cd', type: 'varchar(20)', notNull: false });
      edited = addFk(edited, 'erd_code', { name: 'fk_erd_code_prod', columns: ['prod_cd'], refTable: 'erd_product', refColumns: ['prod_cd'] });
      const alter = buildAlter(model, edited);
      await run(s, alter.sql);
      expect(differences(await read(s), edited)).toEqual([]);

      // 되돌리기 (컬럼 삭제는 기본값 제약을 먼저 지운다)
      await run(s, buildAlter(edited, model).sql);
      expect(differences(await read(s), model)).toEqual([]);
    } finally {
      await s.close();
    }
  }, 120_000);

  it('자동완성 목록: 테이블, 뷰, 컬럼 타입과 코멘트', async () => {
    const cat = await mssqlAdapter.catalog(c);
    expect(cat.dialect).toBe('sqlserver');
    const cust = cat.tables.find(t => t.name === 'erd_customer')!;
    expect([cust.kind, cust.schema, cust.comment]).toEqual(['table', 'dbo', '거래처']);
    expect(cust.columns.find(x => x.name === 'cust_cd')).toEqual({ name: 'cust_cd', type: 'varchar(20)', comment: '거래처 코드' });
    expect(cat.tables.find(t => t.name === 'erd_v_order')?.kind).toBe('view');
  });

  it('세션: 2,500행 나눠 받기, 실패한 문장 뒤에도 트랜잭션 유지, 롤백', async () => {
    const ref = { source: 'manual' as const, id: 'mssql-test' };
    const resolver = async () => T;
    await openSession('m1', ref, 'mssql', resolver);
    const r1 = await runSql('m1', 'SELECT TOP 2500 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) n FROM sys.all_objects a CROSS JOIN sys.all_objects b');
    expect(r1.error).toBeUndefined();
    expect([r1.rows.length, r1.state.more, r1.state.dialect, r1.state.readOnlyByAccount]).toEqual([1000, true, 'sqlserver', true]);
    const r2 = await fetchMore('m1');
    const r3 = await fetchMore('m1');
    expect([r2.rows.length, r3.rows.length, r3.state.more, String(r3.rows[499][0])]).toEqual([1000, 500, false, '2500']); // bigint 는 글자로 온다

    const up = await runSql('m1', "UPDATE erd_code SET cd_nm = N'x' WHERE 1 = 0");
    expect([up.command, up.rowCount, up.state.inTx]).toEqual(['UPDATE', 0, true]);
    await runSql('m1', "INSERT INTO erd_code (grp_cd, cd, cd_nm) VALUES ('G', 'C1', N'before')");
    const bad = await runSql('m1', 'SELECT * FROM no_such_table_erd');
    expect(bad.error?.code).toBe('208');
    expect(bad.state.inTx).toBe(true);
    expect((await runSql('m1', "SELECT cd_nm FROM erd_code WHERE grp_cd = 'G'")).rows).toEqual([['before']]); // 앞 변경이 살아 있다
    const rb = await rollbackTx('m1');
    expect(rb.state.inTx).toBe(false);
    expect((await runSql('m1', "SELECT COUNT(*) FROM erd_code WHERE grp_cd = 'G'")).rows).toEqual([[0]]);
    await commitTx('m1');
    await closeSession('m1');
  }, 60_000);
});
