import { describe, expect, it } from 'vitest';
import { splitStatements, statementAt, stripLiterals } from '../../src/shared/sql/text';
import { buildJoinSelect } from '../../src/shared/sql/join';
import type { SchemaModel, Table } from '../../src/shared/model/types';

describe('이력 리터럴 지우기', () => {
  it('문자열과 숫자를 ? 로 바꾸고 식별자 안 숫자는 둔다', () => {
    expect(stripLiterals("select * from tbl1 t2 where a = 'x' and b = 10 and c in (1, 2.5) and t2.col3 > -3"))
      .toBe('select * from tbl1 t2 where a = ? and b = ? and c in (?, ?) and t2.col3 > ?');
  });
  it("작은따옴표 두 개('')와 E 문자열, 달러 따옴표도 하나의 리터럴로 본다", () => {
    expect(stripLiterals("update t set memo = 'it''s 5', e = E'a\\'b', f = $$x 9$$ where id = 3"))
      .toBe('update t set memo = ?, e = ?, f = ? where id = ?');
  });
  it('주석과 따옴표 식별자 안 내용은 그대로 둔다', () => {
    expect(stripLiterals('select "col 1" from t -- 메모 2026\nwhere x = 1 /* 7 */'))
      .toBe('select "col 1" from t -- 메모 2026\nwhere x = ? /* 7 */');
  });
});

describe('문장 나누기', () => {
  const sql = "select 1;\nselect ';' as a;  \n\n-- 주석 ;\nupdate t set a = 1";
  it('문자열과 주석 안의 ; 는 무시한다', () => {
    expect(splitStatements(sql).map(s => s.text)).toEqual(["select 1", "select ';' as a", '-- 주석 ;\nupdate t set a = 1']);
  });
  it('커서가 있는 문장을 찾는다', () => {
    expect(statementAt(sql, sql.indexOf("';'"))?.text).toBe("select ';' as a");
    expect(statementAt(sql, sql.length)?.text).toBe('-- 주석 ;\nupdate t set a = 1');
    expect(statementAt(sql, 3)?.text).toBe('select 1');
  });
});

describe('JOIN SELECT 만들기', () => {
  const t = (name: string, fks: Table['fks'] = []): Table =>
    ({ id: name, name, comment: '', columns: [], pk: [], fks, uniques: [], indexes: [] });
  const model: SchemaModel = {
    version: 1, groups: [], common: [], sequences: [], functions: [],
    tables: [
      t('mst_biz'),
      t('mst_wh'),
      t('mst_biz_wh', [
        { name: 'f1', columns: ['biz_seq'], refTable: 'mst_biz', refColumns: ['biz_seq'] },
        { name: 'f2', columns: ['wh_seq'], refTable: 'mst_wh', refColumns: ['wh_seq'] },
      ]),
      t('sm_log'),
    ],
  };

  it('직접 FK 로 잇는다', () => {
    expect(buildJoinSelect(model, ['mst_biz_wh', 'mst_biz'])).toBe([
      'SELECT bw.*, b.*',
      '  FROM mst_biz_wh bw',
      '  JOIN mst_biz b ON b.biz_seq = bw.biz_seq',
      'LIMIT 100;',
    ].join('\n'));
  });

  it('두 단계 경로면 중간 테이블도 넣고, 이어지지 않는 테이블은 주석으로 알린다', () => {
    const sql = buildJoinSelect(model, ['mst_biz', 'mst_wh', 'sm_log']);
    expect(sql).toContain('FROM mst_biz b');
    expect(sql).toContain('JOIN mst_biz_wh bw ON bw.biz_seq = b.biz_seq');
    expect(sql).toContain('JOIN mst_wh w ON w.wh_seq = bw.wh_seq');
    expect(sql).toContain('-- FK 로 이어지지 않아 뺀 테이블: sm_log');
  });
});
