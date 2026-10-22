// PostgreSQL DB 시험의 예시 스키마(test/fixtures/seed-postgres.sql)를 준비한다.
// mst_brand 가 이미 있으면 그대로 쓰고, 없으면 넣는다. 다른 테이블이 든 DB(실제 개발 DB 등)에는 넣지 않고 오류를 낸다.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, resolve } from '../../src/main/db/connect';
import { splitStatements } from '../../src/shared/sql/text';

const SEED = fileURLToPath(new URL('../fixtures/seed-postgres.sql', import.meta.url));

export async function ensurePgSample(beDir: string): Promise<void> {
  const c = await connect(await resolve({ source: 'be', beDir, name: 'dev' }), false);
  try {
    const rows = await c.query<{ relname: string }>("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'");
    const names = rows.map(r => r.relname);
    if (names.includes('mst_brand')) return;
    const others = names.filter(n => !n.startsWith('erd_') && n !== 'flyway_schema_history');
    if (others.length) throw new Error(`예시 스키마를 넣을 빈 시험 DB 가 아닙니다 (public 에 테이블 ${others.length}개). ERD_BE_DIR 의 dev 프로필을 빈 시험 DB 로 바꾸세요`);
    await c.exec('BEGIN');
    for (const s of splitStatements(fs.readFileSync(SEED, 'utf8'))) {
      const body = s.text.replace(/^(\s*--[^\n]*\n)+/, '').trim();
      if (body) await c.exec(body);
    }
    await c.exec('COMMIT');
  } catch (e) {
    await c.exec('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.close();
  }
}
