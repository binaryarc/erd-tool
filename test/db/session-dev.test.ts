// 통합 시험: dev DB SQL 세션 (STEP 4 완료 기준 1, 2). 실데이터 테이블은 건드리지 않고 시험용 테이블을 만들었다 지운다.
import { afterAll, describe, expect, it } from 'vitest';
import { getProfile, passwordOf } from '../../src/main/db/profiles';
import { resolve, type Target } from '../../src/main/db/connect';
import { allowWrite, closeSession, commitTx, fetchMore, openSession, rollbackTx, runSql } from '../../src/main/db/session';
import type { ConnRef } from '../../src/shared/ipc';

const BE = process.env.ERD_BE_DIR ?? 'C:/work/workspace/shop-be';
let skip = '';
try { passwordOf(getProfile(BE, 'dev'), BE); } catch (e) { skip = (e as Error).message; }

const dev: ConnRef = { source: 'be', beDir: BE, name: 'dev' };
// 읽기 전용 접속 흉내: dev 접속 정보에 읽기 전용만 켠다 (운영 DB 에는 접속하지 않는다, 사용자 결정)
const readOnlyDev = async (r: ConnRef): Promise<Target> => ({ ...(await resolve(r)), readOnly: true });
const TABLE = 'erd_tool_test_rollback';

describe.skipIf(!!skip)('dev DB SQL 세션', () => {
  afterAll(async () => {
    await openSession('cleanup', dev, 'cleanup');
    await runSql('cleanup', `drop table if exists ${TABLE}`);
    await commitTx('cleanup');
    await closeSession('cleanup');
  });

  it('2,500행 결과를 1,000행씩 나눠 받는다', async () => {
    await openSession('a', dev, 'dev');
    const r1 = await runSql('a', 'select g as n, md5(g::text) as h from generate_series(1, 2500) g');
    expect(r1.error).toBeUndefined();
    expect(r1.columns.map(c => c.name)).toEqual(['n', 'h']);
    expect([r1.rows.length, r1.state.more]).toEqual([1000, true]);
    const r2 = await fetchMore('a');
    const r3 = await fetchMore('a');
    expect([r2.rows.length, r3.rows.length, r3.state.more]).toEqual([1000, 500, false]);
    expect(r3.rows[499][0]).toBe(2500);
    expect(r1.state.dirty).toBe(false); // SELECT 는 변경이 아니다
    await closeSession('a');
  }, 30_000);

  it('UPDATE 후 롤백하면 원래 값이다 (완료 기준 2)', async () => {
    await openSession('b', dev, 'dev');
    await runSql('b', `create table ${TABLE} (id int primary key, val text)`);
    await runSql('b', `insert into ${TABLE} values (1, 'before')`);
    await commitTx('b');

    const up = await runSql('b', `update ${TABLE} set val = 'after' where id = 1`);
    expect([up.command, up.rowCount, up.state.dirty, up.state.inTx]).toEqual(['UPDATE', 1, true, true]);
    expect((await runSql('b', `select val from ${TABLE}`)).rows[0][0]).toBe('after');
    const rb = await rollbackTx('b');
    expect([rb.state.dirty, rb.state.inTx]).toEqual([false, false]);
    expect((await runSql('b', `select val from ${TABLE}`)).rows[0][0]).toBe('before');
    await closeSession('b');
  }, 30_000);

  it('한 문장이 실패해도 트랜잭션은 계속 쓸 수 있다 (savepoint)', async () => {
    await openSession('c', dev, 'dev');
    await runSql('c', `update ${TABLE} set val = 'x' where id = 1`);
    const bad = await runSql('c', 'select * from no_such_table_erd');
    expect(bad.error?.code).toBe('42P01');
    expect((await runSql('c', `select val from ${TABLE}`)).rows[0][0]).toBe('x'); // 앞 변경이 살아 있다
    await rollbackTx('c');
    await closeSession('c');
  }, 30_000);

  it('더 받다가 오류가 나도 탭이 멈추지 않고, 앞 변경과 트랜잭션은 남는다', async () => {
    await openSession('e', dev, 'dev');
    await runSql('e', `update ${TABLE} set val = 'kept' where id = 1`);
    // 1,500번째 행에서 0 으로 나누기: 처음 1,000행은 받고, 더 받을 때 오류가 난다
    const first = await runSql('e', 'select 1 / (g - 1500) v from generate_series(1, 2000) g');
    expect([first.rows.length, first.state.more]).toEqual([1000, true]);
    const more = await fetchMore('e');
    expect(more.error?.code).toBe('22012'); // division_by_zero
    expect(more.state.more).toBe(false);
    // 다음 실행이 끝난다 (전에는 여기서 멈췄다) 그리고 앞 UPDATE 가 살아 있다
    const next = await runSql('e', `select val from ${TABLE}`);
    expect(next.error).toBeUndefined();
    expect(next.rows[0][0]).toBe('kept');
    expect(next.state.dirty).toBe(true);
    await rollbackTx('e');
    await closeSession('e');
  }, 30_000);

  it('읽기 전용 접속에서 UPDATE 는 막히고, 쓰기 허용 후에는 된다 (완료 기준 1)', async () => {
    const st = await openSession('d', dev, 'dev 읽기 전용', readOnlyDev);
    expect(st.readOnly).toBe(true);
    const blocked = await runSql('d', `update ${TABLE} set val = 'ro' where id = 1`);
    expect(blocked.error?.code).toBe('25006'); // read_only_sql_transaction
    expect(blocked.error?.message).toMatch(/read-only transaction/);
    expect((await allowWrite('d')).readOnly).toBe(false);
    const ok = await runSql('d', `update ${TABLE} set val = 'rw' where id = 1`);
    expect(ok.error).toBeUndefined();
    await rollbackTx('d');
    expect((await runSql('d', `select val from ${TABLE}`)).rows[0][0]).toBe('before');
    await closeSession('d');
  }, 30_000);
});
