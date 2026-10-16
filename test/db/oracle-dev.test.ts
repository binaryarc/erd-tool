// 통합 시험 (STEP 9): Oracle 어댑터 (Thin 모드). 도커 erd-oracle (WSL) 이 떠 있지 않으면 건너뛴다.
// 시험 스키마(test/fixtures/seed-oracle.sql)를 ERD 계정에 다시 넣는다. DDL 이 바로 커밋되므로
// 전체 CREATE 와 ALTER 는 system 으로 만든 ERD_SCRATCH 계정에서 시험한 뒤 계정째 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oracleAdapter } from '../../src/main/db/adapters/oracle';
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

const T: Target = { dialect: 'oracle', host: '127.0.0.1', port: 1521, database: 'FREEPDB1', user: 'erd', password: 'test-password', readOnly: false };
const SYSTEM: Target = { ...T, user: 'system' };
const SCRATCH: Target = { ...T, user: 'erd_scratch', password: 'test-password2' };

let skip = '';
try {
  const c = await oracleAdapter.connect(T, false);
  await c.close();
} catch (e) { skip = (e as Error).message; }
if (skip) console.warn(`Oracle 통합 시험을 건너뛴다: ${skip}`);

async function run(c: DbConn, sql: string) {
  for (const s of splitStatements(sql, rulesFor('oracle').text)) {
    const body = s.text.replace(/^(\s*--[^\n]*\n)+/, '').trim();
    if (body && !body.startsWith('--')) await c.exec(body);
  }
}

async function read(c: DbConn, schema: string): Promise<SchemaModel> {
  const r = await oracleAdapter.reverse(c, schema);
  return { version: 2, dialect: 'oracle', schema, groups: [], common: [], sequences: r.sequences, functions: r.functions, tables: r.tables };
}

const differences = (a: SchemaModel, b: SchemaModel) => diffModels(a, b).map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}: ${i.detail}`);

describe.skipIf(!!skip)('Oracle 어댑터 (도커 FREEPDB1)', () => {
  let c: DbConn;
  beforeAll(async () => {
    c = await oracleAdapter.connect(T, false);
    await run(c, fs.readFileSync(path.join(__dirname, '../fixtures/seed-oracle.sql'), 'utf8'));
  }, 60_000);
  afterAll(async () => { await c?.close(); });

  it('리버스한 모델을 저장 → 읽기 → 저장해도 바이트가 같고, 테이블 수와 FK 수가 직접 집계와 같다', async () => {
    const r = await oracleAdapter.reverse(c, 'ERD');
    const counts = await oracleAdapter.count(c, 'ERD');
    expect(r.tables.length).toBe(counts.tables);
    expect(r.tables.reduce((n, t) => n + t.fks.length, 0)).toBe(counts.fks);
    expect(counts).toEqual({ tables: 5, fks: 3 });
    expect(r.warnings).toContain('뷰 ERD_V_ORDER: 모델에 담지 않는다');

    const cust = r.tables.find(t => t.name === 'ERD_CUSTOMER')!;
    expect(cust.comment).toBe('거래처');
    expect(cust.columns.map(x => [x.name, x.type, x.notNull, x.default ?? '', x.identity ?? '', x.comment ?? ''])).toEqual([
      ['CUST_ID', 'number(10)', true, '', 'always', ''],
      ['CUST_CD', 'varchar2(20)', true, '', '', '거래처 코드'],
      ['CUST_NM', 'varchar2(100 char)', true, '', '', ''],
      ['GRADE', 'char(1)', true, "'A'", '', ''],
      ['REG_DT', 'timestamp(3)', true, 'SYSTIMESTAMP', '', ''],
    ]);
    expect(cust.uniques).toEqual([{ name: 'UQ_ERD_CUSTOMER_CD', columns: ['CUST_CD'] }]);
    expect(cust.checks).toEqual([{ name: 'CK_ERD_CUSTOMER_GRADE', definition: "CHECK (grade IN ('A', 'B', 'C'))" }]);
    const item = r.tables.find(t => t.name === 'ERD_ORDER_ITEM')!;
    expect(item.pk).toEqual(['ORDER_NO', 'ORDER_SEQ', 'ITEM_NO']);
    expect(item.fks).toEqual([
      { name: 'FK_ERD_ITEM_ORDER', columns: ['ORDER_NO', 'ORDER_SEQ'], refTable: 'ERD_ORDER', refColumns: ['ORDER_NO', 'ORDER_SEQ'], onDelete: 'cascade' },
      { name: 'FK_ERD_ITEM_PROD', columns: ['PROD_CD'], refTable: 'ERD_PRODUCT', refColumns: ['PROD_CD'], deferrable: 'deferred' },
    ]);
    expect(item.columns.find(x => x.name === 'QTY')?.type).toBe('integer');
    expect(item.columns.find(x => x.name === 'QTY2')).toEqual({ name: 'QTY2', type: 'number', notNull: false, generated: '"QTY"*2' });
    expect(r.tables.find(t => t.name === 'ERD_ORDER')!.indexes).toEqual([{ name: 'IX_ERD_ORDER_CUST', columns: ['CUST_ID', 'ORDER_DT'], unique: false }]);
    expect(r.sequences).toEqual([{ name: 'ERD_SEQ', start: 100, inc: 10 }]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-oracle-'));
    const model = await read(c, 'ERD');
    model.tables.forEach((t, i) => (t.id = `t${i + 1}`));
    model.groups = [{ name: 'erd', isDefault: true }];
    await saveModel(dir, model, emptyLayout());
    const before = fs.readFileSync(path.join(dir, 'erd.erd'), 'utf8');
    const loaded = await loadModel(dir);
    expect(loaded.errors).toEqual([]);
    expect([loaded.model.dialect, loaded.model.schema]).toEqual(['oracle', 'ERD']);
    const again = await saveModel(dir, loaded.model, loaded.layout);
    expect(again.written).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'erd.erd'), 'utf8')).toBe(before);
  }, 60_000);

  it('자동완성 목록: 테이블, 뷰, 컬럼 타입과 코멘트', async () => {
    const cat = await oracleAdapter.catalog(c);
    expect(cat.dialect).toBe('oracle');
    const cust = cat.tables.find(t => t.name === 'ERD_CUSTOMER')!;
    expect([cust.kind, cust.schema, cust.comment]).toEqual(['table', 'ERD', '거래처']);
    expect(cust.columns.find(x => x.name === 'CUST_CD')).toEqual({ name: 'CUST_CD', type: 'varchar2(20)', comment: '거래처 코드' });
    expect(cat.tables.find(t => t.name === 'ERD_V_ORDER')?.kind).toBe('view');
  });

  it('전체 CREATE 를 빈 계정에 실행하고 다시 읽으면 차이 0, 화면 수정 ALTER 를 적용해도 차이 0', async () => {
    const model = await read(c, 'ERD');
    const sys = await oracleAdapter.connect(SYSTEM, false);
    const dropUser = () => sys.exec('DROP USER IF EXISTS erd_scratch CASCADE');
    try {
      await dropUser();
      await sys.exec(`CREATE USER erd_scratch IDENTIFIED BY ${SCRATCH.password} QUOTA UNLIMITED ON users`);
      await sys.exec('GRANT CREATE SESSION, CREATE TABLE, CREATE SEQUENCE TO erd_scratch');
      const s = await oracleAdapter.connect(SCRATCH, false);
      try {
        const target: SchemaModel = { ...model, schema: 'ERD_SCRATCH' };
        await run(s, buildCreateAll(target).sql);
        expect(differences(await read(s, 'ERD_SCRATCH'), target)).toEqual([]);

        let edited = addColumn(target, 'ERD_PRODUCT', { name: 'SORT_NO', type: 'int', notNull: true, default: '0', comment: '정렬 순서' });
        edited = updateColumn(edited, 'ERD_PRODUCT', 'PROD_NM', { type: 'varchar(300)' });
        edited = updateColumn(edited, 'ERD_CUSTOMER', 'GRADE', { default: "'B'", comment: '등급' });
        edited = updateColumn(edited, 'ERD_ORDER', 'AMOUNT', { type: 'number(14,2)' });
        edited = updateColumn(edited, 'ERD_CODE', 'CD_NM', { notNull: true });
        edited = updateTable(edited, 'ERD_CODE', { comment: '공통 코드' });
        edited = addColumn(edited, 'ERD_CODE', { name: 'PROD_CD', type: 'varchar2(20)', notNull: false });
        edited = addFk(edited, 'ERD_CODE', { name: 'FK_ERD_CODE_PROD', columns: ['PROD_CD'], refTable: 'ERD_PRODUCT', refColumns: ['PROD_CD'], onDelete: 'set null' });
        await run(s, buildAlter(target, edited).sql);
        expect(differences(await read(s, 'ERD_SCRATCH'), edited)).toEqual([]);

        await run(s, buildAlter(edited, target).sql);
        expect(differences(await read(s, 'ERD_SCRATCH'), target)).toEqual([]);
      } finally {
        await s.close();
      }
    } finally {
      await dropUser().catch(() => {});
      await sys.close();
    }
  }, 180_000);

  it('세션: 2,500행 나눠 받기, 실패한 문장 뒤에도 트랜잭션 유지, 롤백, PL/SQL 블록', async () => {
    const ref = { source: 'manual' as const, id: 'oracle-test' };
    await openSession('o1', ref, 'oracle', async () => T);
    const r1 = await runSql('o1', 'SELECT level n FROM dual CONNECT BY level <= 2500;');
    expect(r1.error).toBeUndefined();
    expect([r1.rows.length, r1.state.more, r1.state.dialect, r1.state.readOnlyByAccount]).toEqual([1000, true, 'oracle', true]);
    const r2 = await fetchMore('o1');
    const r3 = await fetchMore('o1');
    expect([r2.rows.length, r3.rows.length, r3.state.more, r3.rows[499][0]]).toEqual([1000, 500, false, '2500']);

    const ins = await runSql('o1', "INSERT INTO erd_code (grp_cd, cd, cd_nm) VALUES ('G', 'C1', 'before')");
    expect([ins.command, ins.rowCount, ins.state.dirty]).toEqual(['INSERT', 1, true]);
    const bad = await runSql('o1', 'SELECT * FROM no_such_table_erd');
    expect(bad.error?.code).toBe('ORA-00942');
    expect(bad.error?.position).toBe(15); // FROM 뒤 테이블 이름 자리 (1 부터 센다)
    expect((await runSql('o1', "SELECT cd_nm FROM erd_code WHERE grp_cd = 'G'")).rows).toEqual([['before']]);
    // PL/SQL 블록은 끝 ; 까지 한 문장이고 트랜잭션 시작으로 보지 않는다
    const blk = await runSql('o1', "BEGIN\n  UPDATE erd_code SET cd_nm = 'blk' WHERE grp_cd = 'G';\nEND;");
    expect(blk.error).toBeUndefined();
    expect((await runSql('o1', "SELECT cd_nm FROM erd_code WHERE grp_cd = 'G'")).rows).toEqual([['blk']]);
    await rollbackTx('o1');
    expect((await runSql('o1', "SELECT COUNT(*) FROM erd_code WHERE grp_cd = 'G'")).rows).toEqual([['0']]);
    await commitTx('o1');
    await closeSession('o1');
  }, 60_000);
});
