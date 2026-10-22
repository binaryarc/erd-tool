// 통합 시험: dev(Flyway 로 만든 로컬 DB)와 test 비교 (STEP 5 완료 기준 1).
// test 는 구조만 읽는 읽기 전용 접속이다(사용자 허용 2026-10-15). 운영 DB 는 접속하지 않는다.
// 기대값은 2026-10-15 수동 비교: test 에 V3 함수 2개(fn_lpad, fn_split_part)와 V19 인덱스 6개가 없고,
// test 에는 Flyway 에 없는 인덱스 48개와 프로시저 4개가 있다.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { connect, resolve } from '../../src/main/db/connect';
import { getProfile, passwordOf } from '../../src/main/db/profiles';
import { postgresAdapter } from '../../src/main/db/adapters/postgres';
import type { DbConn } from '../../src/main/db/adapters/types';
import { diffModels, isProcedure, summarize } from '../../src/shared/model/diff';
import type { FunctionDef, SchemaModel } from '../../src/shared/model/types';

const BE = process.env.ERD_BE_DIR ?? 'C:/work/workspace/shop-be';
let skip = '';
try { for (const p of ['dev', 'test']) passwordOf(getProfile(BE, p), BE); } catch (e) { skip = (e as Error).message; }

async function readDb(name: string): Promise<SchemaModel> {
  const client = await connect(await resolve({ source: 'be', beDir: BE, name }), true); // 읽기 전용
  try {
    const r = await postgresAdapter.reverse(client, 'public');
    return { version: 1, groups: [], common: [], tables: r.tables, sequences: r.sequences, functions: r.functions };
  } finally { await client.close(); }
}

// 건너뛸 때는 읽지 않는다 (도커 시험용 BE 에는 test 프로필도 Flyway 파일도 없다)
const v19 = skip ? [] : [...fs.readFileSync(`${BE}/src/main/resource/db/migration/V19__add_mapping_table_unique_index.sql`, 'utf8')
  .matchAll(/INDEX IF NOT EXISTS "([^"]+)"/g)].map(m => m[1]);

describe.skipIf(!!skip)('dev 와 test 비교', () => {
  it('수동 비교 결과와 같다', async () => {
    const [dev, test] = await Promise.all([readDb('dev'), readDb('test')]);
    const d = diffModels(dev, test); // dev 를 test 처럼 바꾸려면 = test 에 없는 것은 drop, test 에만 있는 것은 add
    const fnDrops = d.filter(x => x.kind === 'function' && x.change === 'drop').map(x => x.name);
    const ixDrops = d.filter(x => x.kind === 'index' && x.change === 'drop').map(x => x.name);
    const ixAdds = d.filter(x => x.kind === 'index' && x.change === 'add');
    const procAdds = d.filter(x => x.kind === 'function' && x.change === 'add' && isProcedure(x.to as FunctionDef)).map(x => x.name);
    const result = {
      summary: summarize(d), total: d.length,
      testMissingFunctions: fnDrops, testMissingIndexes: ixDrops, v19MissingInTest: v19.filter(n => ixDrops.includes(n)),
      testOnlyIndexes: ixAdds.length, testOnlyProcedures: procAdds,
      others: d.filter(x => !['index', 'function'].includes(x.kind)).map(x => `${x.kind} ${x.change} ${x.table ?? ''}.${x.name}: ${x.detail}`).slice(0, 40),
      functionAlters: d.filter(x => x.kind === 'function' && x.change === 'alter').map(x => x.name),
    };
    console.log(JSON.stringify(result, null, 1));

    expect(fnDrops.map(n => n.split('(')[0]).sort()).toEqual(expect.arrayContaining(['fn_lpad', 'fn_split_part']));
    expect(result.v19MissingInTest.length).toBe(6);
    expect(ixAdds.length).toBe(48);
    expect(procAdds.length).toBe(4);
    // 2026-10-16 FK 에 DEFERRABLE 을 담은 뒤 새로 드러난 차이: dev 의 FK 81개는 DEFERRABLE, test 는 아니다(다른 차이는 없다)
    const fkAlters = d.filter(x => x.kind === 'fk');
    expect(fkAlters.length).toBe(81);
    expect(fkAlters.every(x => x.change === 'alter' && / DEFERRABLE/.test(String(x.detail.split(' → ')[0])) && !/DEFERRABLE/.test(String(x.detail.split(' → ')[1])))).toBe(true);
  }, 120_000);
});
