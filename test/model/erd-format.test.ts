import { describe, expect, it } from 'vitest';
import { parseModel, serializeModel } from '../../src/shared/model/erd-format';
import { validateModel } from '../../src/shared/model/validate';
import { emptyLayout, parseLayout, serializeLayout } from '../../src/shared/model/layout';
import type { Column, SchemaModel, Table } from '../../src/shared/model/types';
import { SAMPLE_GROUPS } from '../helpers/fixtures';

const COMMON: Column[] = [
  { name: 'reg_id', type: 'varchar(50)', notNull: true, comment: '등록자_ID' },
  { name: 'reg_dt', type: 'timestamp', notNull: true, default: 'now()', comment: '등록_일시' },
];

const table = (id: string, name: string, extra: Partial<Table> = {}): Table => ({
  id, name, comment: '', columns: [{ name: 'seq', type: 'integer', notNull: true }], pk: ['seq'], fks: [], uniques: [], indexes: [], ...extra,
});

const model = (tables: Table[]): SchemaModel => ({ version: 1, groups: SAMPLE_GROUPS, common: COMMON, sequences: [], tables, functions: [] });

/** 저장 → 읽기 → 저장 */
function roundTrip(m: SchemaModel) {
  const first = serializeModel(m);
  const parsed = parseModel(first);
  return { first, parsed, second: serializeModel(parsed.model) };
}

describe('.erd 형식', () => {
  it('저장 → 읽기 → 저장이 바이트 단위로 같다', () => {
    const m = model([
      table('t1', 'mst_brand', { comment: 'MST_사업장', columns: [{ name: 'brand_seq', type: 'integer', notNull: true, default: "nextval('mst_brand_seq'::regclass)", comment: '사업장_SEQ' }, ...COMMON], pk: ['brand_seq'] }),
      table('t2', 'mst_brand_wh', {
        columns: [{ name: 'brand_seq', type: 'integer', notNull: true }, { name: 'wh_seq', type: 'integer', notNull: true }],
        pk: ['brand_seq', 'wh_seq'],
        fks: [{ name: 'fk_wh_brand', columns: ['brand_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] }],
        indexes: [{ name: 'ix_lower', columns: ['lower(wh_seq::text, 1)', 'brand_seq'], unique: true }],
      }),
    ]);
    const { first, parsed, second } = roundTrip(m);
    expect(parsed.errors).toEqual([]);
    expect(second).toEqual(first);
    expect(parsed.model.tables).toEqual(m.tables);
  });

  it('테이블은 넣은 순서와 상관없이 이름순으로 저장된다', () => {
    const files = serializeModel(model([table('t2', 'mst_wh'), table('t1', 'mst_brand'), table('t3', 'mst_center')]));
    const heads = files['tables.erd'].split('\n').filter(l => l && !l.startsWith(' '));
    expect(heads).toEqual(['mst_brand @t1', 'mst_center @t3', 'mst_wh @t2']);
  });

  it('테이블은 접두어 그룹과 상관없이 tables.erd 한 파일에 쓴다 (2026-10-16 사용자 지정). 테이블이 없으면 그 파일도 없다', () => {
    const files = serializeModel(model([table('t1', 'mst_brand'), table('t2', 'whs_in_h'), table('t3', 'flyway_schema_history')]));
    expect(Object.keys(files).sort()).toEqual(['_index.erd', 'tables.erd']);
    expect(files['tables.erd'].split('\n').filter(l => l && !l.startsWith(' '))).toEqual(['flyway_schema_history @t3', 'mst_brand @t1', 'whs_in_h @t2']);
    expect(Object.keys(serializeModel(model([])))).toEqual(['_index.erd']);
  });

  it('예전처럼 접두어 그룹마다 나뉜 파일(mst.erd, whs.erd)도 그대로 읽는다', () => {
    const old = { '_index.erd': 'erd-model 2\ndb postgresql public\ngroup mst prefix=mst_ default\ngroup whs prefix=whs_\n', 'mst.erd': 'mst_a @t1\n  seq integer PK\n', 'whs.erd': 'whs_b @t2\n  seq integer PK\n' };
    const p = parseModel(old);
    expect(validateModel(p)).toEqual([]);
    expect(p.model.tables.map(t => t.name)).toEqual(['mst_a', 'whs_b']);
    expect(serializeModel(p.model)['tables.erd']).toBe('mst_a @t1\n  seq integer PK\nwhs_b @t2\n  seq integer PK\n');
  });

  it('공통 컬럼은 정의와 똑같을 때만 +common 으로 줄인다', () => {
    const same = table('t1', 'mst_a', { columns: [{ name: 'seq', type: 'integer', notNull: true }, ...COMMON] });
    const diff = table('t2', 'mst_b', { columns: [{ name: 'seq', type: 'integer', notNull: true }, COMMON[0], { ...COMMON[1], comment: '다른 코멘트' }] });
    const moved = table('t3', 'mst_c', { columns: [...COMMON, { name: 'seq', type: 'integer', notNull: true }] });
    const { first, parsed } = roundTrip(model([same, diff, moved]));
    expect(first['tables.erd']).toContain('mst_a @t1 +common');
    expect(first['tables.erd']).not.toContain('mst_b @t2 +common');
    expect(first['tables.erd']).not.toContain('mst_c @t3 +common');
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
    expect(first['tables.erd'].split('\n').length).toBe(cols.length + 2); // 줄바꿈 코멘트도 한 줄
  });

  it('시퀀스와 그룹 규칙을 _index.erd 로 보존한다', () => {
    const m = { ...model([table('t1', 'mst_brand')]), sequences: [{ name: 'z_seq', start: 1, inc: 1 }, { name: 'a_seq', start: 100, inc: -1 }] };
    const { first, parsed } = roundTrip(m);
    expect(first['_index.erd']).toBe([
      'erd-model 3', 'db postgresql public', 'group whs prefix=whs_', 'group mst prefix=mst_', 'group sys prefix=sys_ default', 'group sio prefix=sio_', 'group wcs prefix=wcs_',
      'common reg_id varchar(50) NN #등록자_ID', 'common reg_dt timestamp NN =now() #등록_일시',
      'seq a_seq start=100 inc=-1', 'seq z_seq start=1 inc=1', '',
    ].join('\n'));
    expect(parsed.model.groups).toEqual(SAMPLE_GROUPS);
  });

  it('형식 버전 1 파일은 PostgreSQL, public 으로 읽고, 저장하면 지금 버전과 db 줄을 쓴다 (STEP 9)', () => {
    const v1 = { '_index.erd': 'erd-model 1\ngroup mst prefix=mst_ default\n', 'mst.erd': 'mst_a @t1\n  seq integer PK\n' };
    const p = parseModel(v1);
    expect(p.errors).toEqual([]);
    expect([p.model.dialect, p.model.schema]).toEqual([undefined, undefined]);
    const out = serializeModel(p.model);
    expect(out['_index.erd']).toBe('erd-model 3\ndb postgresql public\ngroup mst prefix=mst_ default\n');
    expect(out['tables.erd']).toBe(v1['mst.erd']); // 테이블 줄은 그대로 (파일 이름만 tables.erd)
  });

  it('DB 종류와 스키마를 보존하고, 모르는 DB 종류와 버전은 오류다', () => {
    const { parsed } = roundTrip({ ...model([table('t1', 'mst_brand')]), dialect: 'sqlserver', schema: 'dbo' });
    expect([parsed.model.dialect, parsed.model.schema]).toEqual(['sqlserver', 'dbo']);
    expect(parseModel({ '_index.erd': 'erd-model 2\ndb db2 x\n' }).errors.map(e => e.message)).toEqual(['db 줄 형식이 아닙니다: db db2 x']);
    expect(parseModel({ '_index.erd': 'erd-model 4\n' }).errors.map(e => e.message)).toEqual(['지원하지 않는 형식 버전: 4']);
  });
});

describe('검증', () => {
  it('이름 중복, ID 중복, 없는 FK 대상을 파일과 줄 번호로 알려준다', () => {
    const files = {
      '_index.erd': 'erd-model 1\ngroup mst prefix=mst_ default\n',
      'mst.erd': [
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
      'mst.erd:5 mst_b: ID @t1 가 mst_a 와(과) 겹칩니다',
      'mst.erd:3 테이블 이름 mst_a 이 2번 나옵니다',
      'mst.erd:7 mst_b: FK fk_b_a 의 참조 테이블 mst_none 이(가) 없습니다',
      'mst.erd:8 mst_b: FK fk_b_a2 의 참조 컬럼 mst_a.nope 이(가) 없습니다',
      'mst.erd:9 mst_c: ID 형식이 t숫자가 아닙니다 (@x9)',
    ]));
  });

  it('정상 모델은 오류가 없다', () => {
    expect(validateModel(roundTrip(model([table('t1', 'mst_a')])).parsed)).toEqual([]);
  });
});

describe('layout.json', () => {
  it('키를 정렬해 저장하고 두 번 저장해도 같다', () => {
    const l = emptyLayout();
    l.diagrams['전체'] = { pinned: { t5: [1200, 300] }, groups: { mst: { order: ['t2', 't1'], rule: { origin: [0, 0], gap: 40, cols: 3 } } } };
    const first = serializeLayout(l);
    expect(serializeLayout(parseLayout(first))).toBe(first);
    expect(first.indexOf('"cols"')).toBeLessThan(first.indexOf('"gap"'));
    expect(parseLayout(first).diagrams['전체'].groups!.mst.order).toEqual(['t2', 't1']); // 순서 배열은 그대로
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
    expect(first['tables.erd']).toContain('  UQ uq_a (cd)\n  UQ uq_b (cd, seq)\n');
    expect(Object.keys(first).filter(f => f.startsWith('functions/')).sort()).toEqual(['functions/fn_lpad.sql', 'functions/fn_split.sql']);
    expect(parsed.model.tables[0].uniques.map(u => u.name)).toEqual(['uq_a', 'uq_b']); // 저장하면 이름순
    expect(parsed.model.functions.find(f => f.args === 'text')?.definition).toBe(m.functions[1].definition);
  });

  it('UNIQUE 의 없는 컬럼을 검증 오류로 낸다', () => {
    const t = table('t1', 'mst_a', { uniques: [{ name: 'uq_x', columns: ['nope'] }] });
    expect(validateModel(roundTrip(model([t])).parsed).map(e => e.message)).toEqual(['mst_a: UNIQUE uq_x 의 컬럼 nope 이(가) 없습니다']);
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
    expect(r.first['tables.erd']).toContain('  seq integer PK IDENTITY');
    expect(r.first['tables.erd']).toContain("  qty2 integer =GENERATED ALWAYS AS (qty * 2 + length('a = b')) STORED");
    expect(r.first['tables.erd']).toContain('  CK ck_qty CHECK ((qty >= 0))');
    expect(r.parsed.errors).toEqual([]);
    expect(r.parsed.model.tables[0].columns).toEqual(t.columns);
    expect(r.parsed.model.tables[0].checks).toEqual(t.checks);
    expect(r.second).toEqual(r.first);
  });

  it('이름 바꾼 기록(renamedFrom)은 파일에 남기지 않는다', () => {
    const t = table('t1', 'mst_a', { renamedFrom: 'mst_old', columns: [{ name: 'seq', type: 'integer', notNull: true, renamedFrom: 'id' }] });
    expect(serializeModel(model([t]))['tables.erd']).toBe(serializeModel(model([table('t1', 'mst_a')]))['tables.erd']);
  });

  it('FK 참조 동작과 DEFERRABLE 을 저장하고 그대로 읽는다 (없으면 줄이 전과 같다)', () => {
    const a = table('t1', 'mst_a');
    const fks = [
      { name: 'fk_1', columns: ['seq'], refTable: 'mst_a', refColumns: ['seq'] },
      { name: 'fk_2', columns: ['seq'], refTable: 'mst_a', refColumns: ['seq'], onDelete: 'cascade' as const, onUpdate: 'set null' as const },
      { name: 'fk_3', columns: ['seq'], refTable: 'mst_a', refColumns: ['seq'], deferrable: 'immediate' as const },
      { name: 'fk_4', columns: ['seq'], refTable: 'mst_a', refColumns: ['seq'], onDelete: 'restrict' as const, deferrable: 'deferred' as const },
    ];
    const r = roundTrip(model([{ ...a, fks }]));
    const text = r.first['tables.erd'];
    expect(text).toContain('  FK fk_1 (seq) > mst_a(seq)\n');
    expect(text).toContain('  FK fk_2 (seq) > mst_a(seq) ON DELETE CASCADE ON UPDATE SET NULL\n');
    expect(text).toContain('  FK fk_3 (seq) > mst_a(seq) DEFERRABLE\n');
    expect(text).toContain('  FK fk_4 (seq) > mst_a(seq) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED\n');
    expect(r.parsed.errors).toEqual([]);
    expect(r.parsed.model.tables[0].fks).toEqual(fks);
    expect(r.second).toEqual(r.first);
    // 모르는 꼬리 글자는 형식 오류로 알린다
    expect(parseModel({ '_index.erd': 'erd-model 1\n', 'x.erd': 'mst_a @t1\n  seq integer PK\n  FK f (seq) > mst_a(seq) ON DELETE BOOM\n' }).errors.map(e => e.message))
      .toEqual(['FK 줄 형식이 아닙니다: FK f (seq) > mst_a(seq) ON DELETE BOOM']);
  });
});

describe('IDENTITY 시작값, 증가값 (STEP 9)', () => {
  it('(1,1) 이면 적지 않고, 아니면 IDENTITY(시작,증가) 로 적고 다시 읽는다', () => {
    const t = (c: Partial<Table['columns'][number]>): Table => ({ id: 't1', name: 'mst_a', comment: '', pk: ['seq'], fks: [], uniques: [], indexes: [],
      columns: [{ name: 'seq', type: 'int', notNull: true, identity: 'always', ...c }] });
    const plain = serializeModel(model([t({})]))['tables.erd'];
    expect(plain).toBe('mst_a @t1\n  seq int PK IDENTITY\n');
    const { first, parsed } = roundTrip(model([t({ identityStart: 1000, identityStep: 10 })]));
    expect(first['tables.erd']).toBe('mst_a @t1\n  seq int PK IDENTITY(1000,10)\n');
    expect(parsed.model.tables[0].columns[0]).toMatchObject({ identity: 'always', identityStart: 1000, identityStep: 10 });
    expect(parseModel({ '_index.erd': 'erd-model 2\n', 'm.erd': 'mst_a @t1\n  seq int PK IDENTITY_BD(5,-1)\n' }).model.tables[0].columns[0])
      .toMatchObject({ identity: 'default', identityStart: 5, identityStep: -1 });
  });
});
