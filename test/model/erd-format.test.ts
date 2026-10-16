import { describe, expect, it } from 'vitest';
import { parseModel, serializeModel } from '../../src/shared/model/erd-format';
import { validateModel } from '../../src/shared/model/validate';
import { emptyLayout, parseLayout, serializeLayout } from '../../src/shared/model/layout';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';
import { SHOP_GROUPS } from '../helpers/fixtures';

const COMMON: Column[] = [
  { name: 'reg_id', type: 'varchar(50)', notNull: true, comment: '등록자_ID' },
  { name: 'reg_dt', type: 'timestamp', notNull: true, default: 'now()', comment: '등록_일시' },
];

const table = (id: string, name: string, extra: Partial<Table> = {}): Table => ({
  id, name, comment: '', columns: [{ name: 'seq', type: 'integer', notNull: true }], pk: ['seq'], fks: [], uniques: [], indexes: [], ...extra,
});

const model = (tables: Table[]): SchemaModel => ({ version: 1, groups: SHOP_GROUPS, common: COMMON, sequences: [], tables, functions: [] });

/** 저장 → 읽기 → 저장 */
function roundTrip(m: SchemaModel) {
  const first = serializeModel(m);
  const parsed = parseModel(first);
  return { first, parsed, second: serializeModel(parsed.model) };
}

describe('.erd 형식', () => {
  it('저장 → 읽기 → 저장이 바이트 단위로 같다', () => {
    const m = model([
      table('t1', 'mst_biz', { comment: 'MST_사업장', columns: [{ name: 'biz_seq', type: 'integer', notNull: true, default: "nextval('mst_biz_seq'::regclass)", comment: '사업장_SEQ' }, ...COMMON], pk: ['biz_seq'] }),
      table('t2', 'mst_biz_wh', {
        columns: [{ name: 'biz_seq', type: 'integer', notNull: true }, { name: 'wh_seq', type: 'integer', notNull: true }],
        pk: ['biz_seq', 'wh_seq'],
        fks: [{ name: 'fk_wh_biz', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] }],
        indexes: [{ name: 'ix_lower', columns: ['lower(wh_seq::text, 1)', 'biz_seq'], unique: true }],
      }),
    ]);
    const { first, parsed, second } = roundTrip(m);
    expect(parsed.errors).toEqual([]);
    expect(second).toEqual(first);
    expect(parsed.model.tables).toEqual(m.tables);
  });

  it('테이블은 넣은 순서와 상관없이 이름순으로 저장된다', () => {
    const files = serializeModel(model([table('t2', 'mst_wh'), table('t1', 'mst_biz'), table('t3', 'mst_center')]));
    const heads = files['mdm.erd'].split('\n').filter(l => l && !l.startsWith(' '));
    expect(heads).toEqual(['mst_biz @t1', 'mst_center @t3', 'mst_wh @t2']);
  });

  it('그룹 규칙대로 파일이 나뉘고, 맞는 접두어가 없으면 기본 그룹으로 간다', () => {
    const files = serializeModel(model([table('t1', 'mst_biz'), table('t2', 'whs_iw_h'), table('t3', 'flyway_schema_history')]));
    expect(Object.keys(files).sort()).toEqual(['_index.erd', 'mdm.erd', 'sm.erd', 'wms.erd']);
    expect(files['sm.erd']).toContain('flyway_schema_history @t3');
  });

  it('공통 컬럼은 정의와 똑같을 때만 +common 으로 줄인다', () => {
    const same = table('t1', 'mst_a', { columns: [{ name: 'seq', type: 'integer', notNull: true }, ...COMMON] });
    const diff = table('t2', 'mst_b', { columns: [{ name: 'seq', type: 'integer', notNull: true }, COMMON[0], { ...COMMON[1], comment: '다른 코멘트' }] });
    const moved = table('t3', 'mst_c', { columns: [...COMMON, { name: 'seq', type: 'integer', notNull: true }] });
    const { first, parsed } = roundTrip(model([same, diff, moved]));
    expect(first['mdm.erd']).toContain('mst_a @t1 +common');
    expect(first['mdm.erd']).not.toContain('mst_b @t2 +common');
    expect(first['mdm.erd']).not.toContain('mst_c @t3 +common');
    expect(parsed.model.tables.map(t => t.columns)).toEqual([same.columns, diff.columns, moved.columns]);
  });

  it('기본값과 코멘트의 공백, 따옴표, 괄호, #, 줄바꿈을 그대로 보존한다', () => {
    const cols: Column[] = [
      { name: 'seq', type: 'integer', notNull: true },
      { name: 'cd', type: 'varchar(50)', notNull: true, default: "'OWN'::character varying", comment: '코드 # 설명' },
      { name: 'memo', type: 'varchar(10)', notNull: false, default: "'a # b (c)'", comment: '여러 줄\n둘째 줄 \\ 역슬래시' },
      { name: 'amt', type: 'numeric(10,2)', notNull: false, default: '0' },
      { name: 'ts', type: 'timestamp with time zone', notNull: false, default: '' },
    ];
    const t = table('t1', 'mst_x', { comment: '테이블 # 코멘트', columns: cols });
    const { first, parsed, second } = roundTrip(model([t]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.model.tables[0]).toEqual(t);
    expect(second).toEqual(first);
    expect(first['mdm.erd'].split('\n').length).toBe(cols.length + 2); // 줄바꿈 코멘트도 한 줄
  });

  it('시퀀스와 그룹 규칙을 _index.erd 로 보존한다', () => {
    const m = { ...model([table('t1', 'mst_biz')]), sequences: [{ name: 'z_seq', start: 1, inc: 1 }, { name: 'a_seq', start: 100, inc: -1 }] };
    const { first, parsed } = roundTrip(m);
    expect(first['_index.erd']).toBe([
      'erd-model 1', 'group wms prefix=whs_', 'group mdm prefix=mst_', 'group sm prefix=sm_ default', 'group sif prefix=sif_', 'group wes prefix=wes_',
      'common reg_id varchar(50) NN #등록자_ID', 'common reg_dt timestamp NN =now() #등록_일시',
      'seq a_seq start=100 inc=-1', 'seq z_seq start=1 inc=1', '',
    ].join('\n'));
    expect(parsed.model.groups).toEqual(SHOP_GROUPS);
  });
});

describe('검증', () => {
  it('이름 중복, ID 중복, 없는 FK 대상을 파일과 줄 번호로 알려준다', () => {
    const files = {
      '_index.erd': 'erd-model 1\ngroup mdm prefix=mst_ default\n',
      'mdm.erd': [
        'mst_a @t1',
        '  seq integer PK',
        'mst_a @t2',
        '  seq integer PK',
        'mst_b @t1',
        '  a_seq integer NN',
        '  FK fk_b_a (a_seq) > mst_none(seq)',
        '  FK fk_b_a2 (a_seq) > mst_a(nope)',
        'mst_c @x9',
        '  seq integer',
        '',
      ].join('\n'),
    };
    const errors = validateModel(parseModel(files));
    const text = errors.map(e => `${e.file}:${e.line} ${e.message}`);
    expect(text).toEqual(expect.arrayContaining([
      'mdm.erd:5 mst_b: ID @t1 가 mst_a 와 겹친다',
      'mdm.erd:3 테이블 이름 mst_a 이 2번 나온다',
      'mdm.erd:7 mst_b: FK fk_b_a 의 참조 테이블 mst_none 이 없다',
      'mdm.erd:8 mst_b: FK fk_b_a2 의 참조 컬럼 mst_a.nope 이 없다',
      'mdm.erd:9 mst_c: ID 형식이 t숫자 가 아니다 (@x9)',
    ]));
  });

  it('정상 모델은 오류가 없다', () => {
    expect(validateModel(roundTrip(model([table('t1', 'mst_a')])).parsed)).toEqual([]);
  });
});

describe('layout.json', () => {
  it('키를 정렬해 저장하고 두 번 저장해도 같다', () => {
    const l = emptyLayout();
    l.diagrams['전체'] = { pinned: { t5: [1200, 300] }, groups: { mdm: { order: ['t2', 't1'], rule: { origin: [0, 0], gap: 40, cols: 3 } } } };
    const first = serializeLayout(l);
    expect(serializeLayout(parseLayout(first))).toBe(first);
    expect(first.indexOf('"cols"')).toBeLessThan(first.indexOf('"gap"'));
    expect(parseLayout(first).diagrams['전체'].groups.mdm.order).toEqual(['t2', 't1']); // 순서 배열은 그대로
  });
});

describe('UNIQUE 제약과 함수', () => {
  it('UQ 줄과 functions/*.sql 을 저장 → 읽기 → 저장해도 바이트 동일', () => {
    const t = table('t1', 'mst_a', {
      columns: [{ name: 'seq', type: 'integer', notNull: true }, { name: 'cd', type: 'varchar(10)', notNull: true }],
      uniques: [{ name: 'uq_b', columns: ['cd', 'seq'] }, { name: 'uq_a', columns: ['cd'] }],
    });
    const m = { ...model([t]), functions: [
      { name: 'fn_lpad', args: 'text, integer', definition: 'CREATE OR REPLACE FUNCTION public.fn_lpad(text, integer)\n RETURNS text\nAS $$ select 1 $$;' },
      { name: 'fn_lpad', args: 'text', definition: 'CREATE OR REPLACE FUNCTION public.fn_lpad(text)\n\n  RETURNS text' },
      { name: 'fn_split', args: '', definition: 'CREATE FUNCTION fn_split()' },
    ] };
    const { first, parsed, second } = roundTrip(m);
    expect(parsed.errors).toEqual([]);
    expect(second).toEqual(first);
    expect(first['mdm.erd']).toContain('  UQ uq_a (cd)\n  UQ uq_b (cd, seq)\n');
    expect(Object.keys(first).filter(f => f.startsWith('functions/')).sort()).toEqual(['functions/fn_lpad.sql', 'functions/fn_split.sql']);
    expect(parsed.model.tables[0].uniques.map(u => u.name)).toEqual(['uq_a', 'uq_b']); // 저장하면 이름순
    expect(parsed.model.functions.find(f => f.args === 'text')?.definition).toBe(m.functions[1].definition);
  });

  it('UNIQUE 의 없는 컬럼을 검증 오류로 낸다', () => {
    const t = table('t1', 'mst_a', { uniques: [{ name: 'uq_x', columns: ['nope'] }] });
    expect(validateModel(roundTrip(model([t])).parsed).map(e => e.message)).toEqual(['mst_a: UNIQUE uq_x 의 컬럼 nope 이 없다']);
  });

  it('CHECK 제약, identity, 생성 컬럼을 저장하고 그대로 읽는다', () => {
    const t = table('t1', 'mst_a', {
      columns: [
        { name: 'seq', type: 'integer', notNull: true, identity: 'always' },
        { name: 'qty', type: 'integer', notNull: false, comment: '수량 #1' },
        { name: 'qty2', type: 'integer', notNull: false, generated: "qty * 2 + length('a = b')" },
        { name: 'no', type: 'bigint', notNull: true, identity: 'default' },
      ],
      checks: [{ name: 'ck_qty', definition: 'CHECK ((qty >= 0))' }],
    });
    const r = roundTrip(model([t]));
    expect(r.first['mdm.erd']).toContain('  seq integer PK IDENTITY');
    expect(r.first['mdm.erd']).toContain("  qty2 integer =GENERATED ALWAYS AS (qty * 2 + length('a = b')) STORED");
    expect(r.first['mdm.erd']).toContain('  CK ck_qty CHECK ((qty >= 0))');
    expect(r.parsed.errors).toEqual([]);
    expect(r.parsed.model.tables[0].columns).toEqual(t.columns);
    expect(r.parsed.model.tables[0].checks).toEqual(t.checks);
    expect(r.second).toEqual(r.first);
  });

  it('이름 바꾼 기록(renamedFrom)은 파일에 남기지 않는다', () => {
    const t = table('t1', 'mst_a', { renamedFrom: 'mst_old', columns: [{ name: 'seq', type: 'integer', notNull: true, renamedFrom: 'id' }] });
    expect(serializeModel(model([t]))['mdm.erd']).toBe(serializeModel(model([table('t1', 'mst_a')]))['mdm.erd']);
  });
});
