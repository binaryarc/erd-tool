// 통합 시험 (STEP 8): AI 조회 db_query 는 dev 에서도 읽기만 한다
import { describe, expect, it } from 'vitest';
import { dbQuery } from '../../src/main/mcp/db-query';
import { getProfile, passwordOf } from '../../src/main/db/profiles';

const BE = process.env.ERD_BE_DIR ?? 'C:/work/workspace/shop-be';
let skip = '';
try { passwordOf(getProfile(BE, 'dev'), BE); } catch (e) { skip = (e as Error).message; }
const dev = { source: 'be' as const, beDir: BE, name: 'dev' };

describe.skipIf(!!skip)('db_query (dev, 읽기 전용)', () => {
  it('SELECT 는 앞 몇 행과 전체 행 수', async () => {
    const out = await dbQuery(dev, 'select g as n from generate_series(1, 120) g;', { show: 3, count: 100 });
    expect(out).toBe('n\n1\n2\n3\n(전체 100행 넘음, 앞 3행만 보임. 읽기 전용 조회)');
  });
  it('쓰기, 읽기 전용 풀기, 여러 문장은 DB 가 막는다', async () => {
    await expect(dbQuery(dev, 'create table erd_tool_probe_q (id int)')).rejects.toThrow(/read-only transaction/);
    await expect(dbQuery(dev, "update mst_biz set biz_nm = biz_nm where false")).rejects.toThrow(/read-only transaction/);
    await expect(dbQuery(dev, 'set transaction read write')).rejects.toThrow(/before any query/);
    await expect(dbQuery(dev, 'select 1; create table erd_tool_probe_q (id int)')).rejects.toThrow(/multiple commands|cannot insert multiple/);
    const left = await dbQuery(dev, "select count(*) n from pg_class where relname = 'erd_tool_probe_q'");
    expect(left.split('\n')[1]).toBe('0');
  });
});
