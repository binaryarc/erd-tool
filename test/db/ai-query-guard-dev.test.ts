// 통합 시험: SQL Server, Oracle 의 AI 조회(db_query)는 쓰기를 DB 에 보내기 전에 거부해 시험용 테이블 행 수가 그대로다.
// 접속 정보(test/.env.local 의 ERD_MSSQL_URL, ERD_ORACLE_URL)가 없거나 DB 가 떠 있지 않으면 건너뛴다. 시험용 테이블 erd_ai_probe 는 만들고 끝에 지운다.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbConn, Target } from '../../src/main/db/adapters/types';
import { mssqlAdapter } from '../../src/main/db/adapters/mssql';
import { oracleAdapter } from '../../src/main/db/adapters/oracle';
import { envTarget, missing } from '../helpers/db-targets';

const KEYS = { sqlserver: 'ERD_MSSQL_URL', oracle: 'ERD_ORACLE_URL' } as const;
const targets = { sqlserver: envTarget(KEYS.sqlserver, 'sqlserver', { trustCert: true }), oracle: envTarget(KEYS.oracle, 'oracle') };
let current = targets.sqlserver as Target;
vi.mock('../../src/main/db/connect', async importOriginal => {
  const orig = await importOriginal<typeof import('../../src/main/db/connect')>();
  return { ...orig, connectRef: (ref: never, ro?: boolean) => orig.connectRef(ref, ro, async () => current) };
});
const { dbQuery } = await import('../../src/main/mcp/db-query');

const ref = { source: 'be' as const, beDir: 'x', name: 'dev' };
const writes = [
  'INSERT INTO erd_ai_probe (id) VALUES (2)',
  'UPDATE erd_ai_probe SET id = 9',
  'DELETE FROM erd_ai_probe',
  'DELETE FROM erd_ai_probe; COMMIT',
  'DROP TABLE erd_ai_probe',
  'BEGIN DELETE FROM erd_ai_probe; COMMIT; END;',
];

for (const [dbms, adapter] of [['sqlserver', mssqlAdapter], ['oracle', oracleAdapter]] as const) {
  const t = targets[dbms];
  let skip = t ? '' : missing(KEYS[dbms]);
  let c: DbConn | undefined;
  if (t) try { c = await adapter.connect(t, false); } catch (e) { skip = (e as Error).message; }
  if (skip) console.warn(`${dbms} AI 조회 시험을 건너뛴다: ${skip}`);

  describe.skipIf(!!skip)(`AI 조회 쓰기 차단 (${dbms})`, () => {
    const count = async () => Number(Object.values((await c!.query('SELECT COUNT(*) AS n FROM erd_ai_probe'))[0])[0]);
    beforeAll(async () => {
      await c!.exec('DROP TABLE erd_ai_probe').catch(() => {});
      await c!.exec('CREATE TABLE erd_ai_probe (id INT)');
      await c!.exec('INSERT INTO erd_ai_probe (id) VALUES (1)');
      if (dbms === 'oracle') await c!.exec('COMMIT');
    });
    afterAll(async () => {
      await c!.exec('DROP TABLE erd_ai_probe').catch(() => {});
      await c!.close();
    });

    it('쓰기는 모두 거부되고 행 수가 그대로다', async () => {
      current = t!;
      for (const sql of writes) await expect(dbQuery(ref, sql), sql).rejects.toThrow(/AI 조회는/);
      expect(await count()).toBe(1);
    });
    it('SELECT, WITH ... SELECT 는 결과가 나온다', async () => {
      current = t!;
      expect(await dbQuery(ref, 'SELECT id FROM erd_ai_probe')).toMatch(/^id\n1\n/i);
      expect(await dbQuery(ref, 'WITH x AS (SELECT id FROM erd_ai_probe) SELECT id FROM x')).toContain('1');
    });
  });
}
