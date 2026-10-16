// 통합 시험 (STEP 7 완료 기준): 화면 수정으로 만든 Flyway 파일을 로컬 dev 에 적용하고 다시 리버스하면 모델 차이가 0 이다.
// Flyway 처럼 파일 하나를 한 트랜잭션에서 실행하고, 같은 연결로 public 을 다시 읽어 비교한 뒤 끝에 롤백한다. dev 에 커밋하지 않는다.
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { connect, resolve } from '../../src/main/db/connect';
import { getProfile, passwordOf } from '../../src/main/db/profiles';
import { reversePg } from '../../src/main/db/pg-reverse';
import { diffModels } from '../../src/shared/model/diff';
import { addColumn, addFk, addTable, updateColumn } from '../../src/shared/model/edit';
import { buildFlyway } from '../../src/shared/export/flyway';
import { splitStatements } from '../../src/shared/sql/text';
import type { SchemaModel } from '../../src/shared/model/types';

const BE = process.env.ERD_BE_DIR ?? 'C:/work/workspace/shop-be';
let skip = '';
try { passwordOf(getProfile(BE, 'dev'), BE); } catch (e) { skip = (e as Error).message; }

async function run(client: pg.Client, sql: string) {
  for (const s of splitStatements(sql)) {
    const body = s.text.replace(/^(--[^\n]*\n)+/, '').trim();
    if (body) await client.query(body);
  }
}

/** 함수 정의는 PostgreSQL 이 다시 써서 돌려주므로 정의 차이는 보지 않는다 (STEP 5 시험과 같다) */
const differences = (a: SchemaModel, b: SchemaModel) =>
  diffModels(a, b).filter(d => !(d.kind === 'function' && d.change === 'alter')).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}: ${d.detail}`);

describe.skipIf(!!skip)('STEP 7 Flyway 파일을 dev 에 적용 (롤백)', () => {
  it('적용 뒤 다시 읽으면 차이 0, 두 번 실행해도 오류 없음, ROLLBACK 블록으로 원래대로', async () => {
    const client = await connect(await resolve({ source: 'be', beDir: BE, name: 'dev' }), false);
    try {
      await client.query('BEGIN');
      const read = async (like: SchemaModel): Promise<SchemaModel> => {
        const r = await reversePg(client);
        return { ...like, tables: r.tables, sequences: r.sequences, functions: r.functions };
      };
      const empty: SchemaModel = { version: 1, groups: [], common: [], sequences: [], functions: [], tables: [] };
      const before = await read(empty);

      // 화면에서 하는 것과 같은 수정: 새 테이블, PK 컬럼, FK, 기존 테이블 컬럼 추가와 코멘트
      let edited = addTable(before, 'mst_erd_probe', { comment: 'ERD 도구 시험' });
      edited = addColumn(edited, 'mst_erd_probe', { name: 'probe_seq', type: 'int', notNull: false, pk: true });
      edited = addColumn(edited, 'mst_erd_probe', { name: 'biz_seq', type: 'integer', notNull: false, comment: '사업장' });
      edited = addFk(edited, 'mst_erd_probe', { name: 'fk_mst_erd_probe_mst_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] });
      edited = addColumn(edited, 'mst_biz', { name: 'erd_sort_no', type: 'integer', notNull: true, default: '0' });
      edited = updateColumn(edited, 'mst_biz', 'biz_nm', { comment: '사업장 이름 (시험)' });

      const file = buildFlyway({ from: before, to: edited, version: 999, description: 'erd_tool_probe', fromLabel: 'dev', toLabel: '지금 ERD', now: new Date() });
      await run(client, file.sql);
      expect(differences(await read(edited), edited)).toEqual([]);

      // 여러 번 실행해도 안전한가 (허브 규칙 4절 2번)
      await run(client, file.sql);
      expect(differences(await read(edited), edited)).toEqual([]);

      // ROLLBACK 주석 블록을 풀어 실행하면 수정 전으로
      const rollback = file.sql.slice(file.sql.indexOf('-- ROLLBACK')).split('\n').slice(7).map(l => l.replace(/^-- ?/, '')).join('\n');
      await run(client, rollback);
      expect(differences(await read(before), before)).toEqual([]);
      console.log(JSON.stringify({ fileName: file.fileName, statements: file.statements, dangers: file.dangers, items: file.items.length }));
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      const left = await client.query("select count(*)::int n from pg_class where relname = 'mst_erd_probe'");
      expect(left.rows[0].n).toBe(0); // dev 에 남은 것 없음
      await client.end();
    }
  }, 120_000);
});
