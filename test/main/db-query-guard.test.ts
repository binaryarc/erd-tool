// AI 조회(db_query) 앱 쪽 검사: 서버가 읽기 전용을 막지 못하는 SQL Server, Oracle 은 DB 에 보내기 전에 쓰기를 거부한다
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dialect } from '../../src/shared/dialect/names';

const sent: string[] = [];
let dialect: Dialect = 'sqlserver';
vi.mock('../../src/main/db/connect', () => ({
  connectRef: async () => ({
    adapter: { dialect, beginAiQuery: async () => {} },
    conn: {
      cursor: (sql: string) => { sent.push(sql); return { read: async () => ({ rows: [[1]], fields: ['n'] }), close: async () => {} }; },
      rollback: async () => {}, close: async () => {},
    },
  }),
}));
const { checkAiSql, dbQuery } = await import('../../src/main/mcp/db-query');

const ref = { source: 'be' as const, beDir: 'x', name: 'dev' };
beforeEach(() => { sent.length = 0; });

describe('AI 조회 쓰기 차단 (SQL Server, Oracle)', () => {
  const writes = [
    'insert into t values (1)',
    'UPDATE t SET a = 1',
    'delete from t',
    'DELETE FROM t; COMMIT',
    'drop table t',
    'BEGIN DELETE FROM t; COMMIT; END;',
    'select 1 delete from t', // T-SQL 은 ; 없이도 두 문장이다
    'select * into t2 from t', // SQL Server 는 새 테이블을 만든다
    'with x as (select 1 a) delete from t',
    '/* select */ truncate table t',
    'exec sp_rename t, t2',
    'select 1; select 2',
  ];
  for (const dbms of ['sqlserver', 'oracle'] as const) {
    it(`${dbms}: 쓰기, 여러 문장은 DB 에 보내기 전에 거부한다`, async () => {
      dialect = dbms;
      for (const sql of writes) await expect(dbQuery(ref, sql), sql).rejects.toThrow(/AI 조회는/);
      expect(sent).toEqual([]);
    });
    it(`${dbms}: SELECT, WITH ... SELECT 는 그대로 실행한다`, async () => {
      dialect = dbms;
      for (const sql of ['select 1 n', '-- 메모\nWITH x AS (SELECT 1 n) SELECT n FROM x;', "select 'delete; drop' as s, \"update\" from t", 'select [insert] from t']) {
        expect(await dbQuery(ref, sql)).toContain('n');
      }
      expect(sent.length).toBe(4);
    });
  }
  it('PostgreSQL, MySQL 은 앱이 막지 않고 DB 서버에 맡긴다 (지금 동작 그대로)', async () => {
    for (const dbms of ['postgresql', 'mysql'] as const) {
      dialect = dbms;
      await dbQuery(ref, 'delete from t');
    }
    expect(sent).toEqual(['delete from t', 'delete from t']);
  });
  it('검사 함수는 이유를 돌려준다', () => {
    expect(checkAiSql('select 1')).toBeNull();
    expect(checkAiSql('delete from t')).toMatch(/SELECT, WITH/);
    expect(checkAiSql('select 1; select 2')).toMatch(/하나/);
    expect(checkAiSql('with x as (select 1) update t set a = 1')).toMatch(/UPDATE/);
  });
});
