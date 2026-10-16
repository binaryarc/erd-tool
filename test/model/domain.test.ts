import { describe, expect, it } from 'vitest';
import {
  EditError, EditHistory, addColumn, addDomain, domainUsage, dropDomain, setColumnDomain, updateColumn, updateDomain,
} from '../../src/shared/model/edit';
import { parseModel, serializeModel } from '../../src/shared/model/erd-format';
import { validateModel } from '../../src/shared/model/validate';
import { mergeModel } from '../../src/shared/model/merge';
import { diffModels } from '../../src/shared/model/diff';
import { buildCreateAll } from '../../src/shared/sql/create';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';
import type { Dialect } from '../../src/shared/dialect/names';

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, ...extra });
const table = (id: string, name: string, columns: Column[], extra: Partial<Table> = {}): Table =>
  ({ id, name, comment: '', columns, pk: [], fks: [], uniques: [], indexes: [], ...extra });
const common = [col('reg_id', 'varchar(20)', { notNull: true })];

const base: SchemaModel = {
  version: 3, groups: [{ name: 'mdm', prefix: 'mst_', isDefault: true }], common, sequences: [], functions: [],
  tables: [
    table('t1', 'mst_biz', [col('biz_seq', 'integer', { notNull: true }), col('biz_cd', 'varchar(10)'), ...common], { pk: ['biz_seq'] }),
    table('t2', 'mst_wh', [col('wh_seq', 'integer', { notNull: true }), col('wh_cd', 'varchar(10)'), col('memo', 'text'), ...common], { pk: ['wh_seq'] }),
  ],
};
const T = (m: SchemaModel, n: string) => m.tables.find(t => t.name === n)!;
const C = (m: SchemaModel, t: string, c: string) => T(m, t).columns.find(x => x.name === c)!;

/** 도메인 code 를 두 테이블 코드 컬럼에 연결한 모델 */
function withCode(): SchemaModel {
  let m = addDomain(base, 'code', 'VARCHAR(10)');
  m = setColumnDomain(m, 'mst_biz', 'biz_cd', 'code');
  return setColumnDomain(m, 'mst_wh', 'wh_cd', 'code');
}

describe('도메인 (STEP 10)', () => {
  it('도메인을 컬럼에 지정하면 타입이 도메인 타입이 되고, 해제하면 타입은 그대로 연결만 풀린다', () => {
    let m = addDomain(base, 'long_txt', 'varchar(500)');
    m = setColumnDomain(m, 'mst_wh', 'memo', 'long_txt');
    expect(C(m, 'mst_wh', 'memo')).toEqual(col('memo', 'varchar(500)', { domain: 'long_txt' }));
    m = setColumnDomain(m, 'mst_wh', 'memo', null);
    expect(C(m, 'mst_wh', 'memo')).toEqual(col('memo', 'varchar(500)'));
    expect(() => setColumnDomain(m, 'mst_wh', 'memo', 'none')).toThrow(EditError);
    expect(() => addDomain(m, 'long_txt', 'text')).toThrow(EditError);
    expect(() => addDomain(m, 'a b', 'text')).toThrow(EditError);
  });

  it('도메인 타입을 바꾸면 쓰는 모든 컬럼이 바뀌고 되돌리기 한 번으로 돌아간다. 컬럼 타입 칸을 고쳐도 같다 (결정 3)', () => {
    const m = withCode();
    const h = new EditHistory();
    h.push(m);
    const a = updateDomain(m, 'code', { type: 'varchar(20)' });
    expect([C(a, 'mst_biz', 'biz_cd').type, C(a, 'mst_wh', 'wh_cd').type, a.domains![0].type]).toEqual(['varchar(20)', 'varchar(20)', 'varchar(20)']);
    expect(h.undo(a)).toBe(m);
    // 연결된 컬럼의 타입 칸을 고치면 도메인을 고친다 (다른 칸 수정은 함께 적용)
    const b = updateColumn(m, 'mst_wh', 'wh_cd', { type: 'varchar(30)', comment: '창고코드' });
    expect([C(b, 'mst_biz', 'biz_cd').type, C(b, 'mst_wh', 'wh_cd').type, C(b, 'mst_wh', 'wh_cd').comment]).toEqual(['varchar(30)', 'varchar(30)', '창고코드']);
    expect(domainUsage(b, 'code')).toEqual([{ table: 'mst_biz', column: 'biz_cd' }, { table: 'mst_wh', column: 'wh_cd' }]);
    // 차이 계산과 ALTER 는 컬럼 타입만 본다
    expect(diffModels(m, b).map(d => `${d.kind} ${d.change} ${d.table}.${d.name}`)).toEqual(['column alter mst_biz.biz_cd', 'column alter mst_wh.wh_cd']);
  });

  it('이름을 바꾸면 연결이 따라가고, 지우면 연결만 풀고 타입은 남는다 (결정 4, 5)', () => {
    const m = withCode();
    const r = updateDomain(m, 'code', { name: 'cd10' });
    expect([C(r, 'mst_biz', 'biz_cd').domain, C(r, 'mst_wh', 'wh_cd').domain, r.domains![0].name]).toEqual(['cd10', 'cd10', 'cd10']);
    const d = dropDomain(r, 'cd10');
    expect(d.domains).toEqual([]);
    expect(C(d, 'mst_wh', 'wh_cd')).toEqual(col('wh_cd', 'varchar(10)'));
  });

  it('새 컬럼에 도메인을 주면 도메인 타입으로 만든다 (AI 의 %도메인 표기도 같은 길)', () => {
    const m = addColumn(withCode(), 'mst_biz', { name: 'up_cd', type: 'int', notNull: false, domain: 'code' });
    expect(C(m, 'mst_biz', 'up_cd')).toEqual(col('up_cd', 'varchar(10)', { domain: 'code' }));
    expect(() => addColumn(m, 'mst_biz', { name: 'x', type: 'int', notNull: false, domain: 'nope' })).toThrow(EditError);
  });

  it('도메인이 든 모델을 저장 → 읽기 → 저장해도 바이트가 같고, DDL 에는 도메인이 나오지 않는다', () => {
    let m = withCode();
    m = addDomain(m, 'seq_id', 'integer');
    m = setColumnDomain(m, 'mst_biz', 'biz_seq', 'seq_id');
    const first = serializeModel(m);
    expect(first['_index.erd']).toContain('domain code varchar(10)\ndomain seq_id integer\n');
    expect(first['tables.erd']).toContain('  biz_seq integer %seq_id PK\n  biz_cd varchar(10) %code\n');
    const parsed = parseModel(first);
    expect(validateModel(parsed)).toEqual([]);
    expect(serializeModel(parsed.model)).toEqual(first);
    expect(parsed.model.tables[0].columns.slice(0, 2)).toEqual(m.tables[0].columns.slice(0, 2));
    expect(buildCreateAll(m).sql).not.toContain('%');
  });

  it('형식 버전 2 모델이 그대로 열리고 검증은 없는 도메인, 다른 타입을 잡는다', () => {
    const v2 = { '_index.erd': 'erd-model 2\ndb postgresql public\ngroup mdm prefix=mst_ default\n', 'mdm.erd': 'mst_a @t1\n  seq integer PK\n' };
    const p = parseModel(v2);
    expect(validateModel(p)).toEqual([]);
    expect(p.model.domains).toBeUndefined();
    const bad = parseModel({ '_index.erd': 'erd-model 3\ndomain code varchar(10)\n', 'mdm.erd': 'mst_a @t1\n  a varchar(20) %code\n  b text %none\n' });
    expect(validateModel(bad).map(e => e.message)).toEqual([
      'mst_a: 컬럼 a 의 타입 varchar(20) 이 도메인 code 의 타입 varchar(10) 와(과) 다릅니다', 'mst_a: 컬럼 b 의 도메인 none 이(가) 없습니다']);
  });

  it('공통 컬럼과 도메인이 다르면 +common 으로 줄이지 않는다 (줄이면 도메인이 사라진다)', () => {
    let m = addDomain(base, 'user_id', 'varchar(20)');
    m = setColumnDomain(m, 'mst_biz', 'reg_id', 'user_id');
    const out = serializeModel(m)['tables.erd'];
    expect(out).toContain('mst_biz @t1\n');
    expect(out).toContain('  reg_id varchar(20) %user_id NN\n');
    expect(out).toContain('mst_wh @t2 +common\n');
  });

  it('DB 에서 다시 불러오면 연결을 이어받고, 타입이 달라진 컬럼만 풀고 경고하며 그 테이블을 바뀐 것으로 잡는다', () => {
    const prev = withCode();
    // DB 를 다시 읽은 모양: 도메인 표시 없음, mst_wh.wh_cd 만 varchar(12) 로 바뀜
    const db: SchemaModel = { ...base, tables: base.tables.map(t => (t.name === 'mst_wh' ? { ...t, columns: t.columns.map(c => (c.name === 'wh_cd' ? { ...c, type: 'varchar(12)' } : c)) } : t)) };
    const { model, diff, warnings } = mergeModel(prev, { ...db, domains: prev.domains });
    expect(C(model, 'mst_biz', 'biz_cd').domain).toBe('code');
    expect(C(model, 'mst_wh', 'wh_cd').domain).toBeUndefined();
    expect(warnings).toEqual(['mst_wh.wh_cd: DB 타입 varchar(12) 이 도메인 code 의 타입 varchar(10) 과 달라 도메인 연결을 풀었습니다']);
    expect(diff.changed).toEqual(['mst_wh']);
    // 같은 DB 를 한 번 더: 바뀐 것 없음
    expect(mergeModel(model, { ...db, domains: model.domains }).diff.changed).toEqual([]);
  });

  it('도메인 타입은 모델의 DB 종류에 맞춰 정리한다 (4개 DB 종류)', () => {
    const got = (['postgresql', 'sqlserver', 'mysql', 'oracle'] as Dialect[]).map(d =>
      [d, addDomain({ ...base, dialect: d, schema: 's' }, 'n', 'INT').domains![0].type, addDomain({ ...base, dialect: d, schema: 's' }, 'v', 'VARCHAR(10)').domains![0].type]);
    for (const [d, i, v] of got) {
      expect(i, d).toBe(i.toLowerCase());
      expect(v, d).toMatch(/^(n?varchar2?|character varying)\(10\)$/);
    }
    expect(got[0]).toEqual(['postgresql', 'integer', 'varchar(10)']);
  });
});
