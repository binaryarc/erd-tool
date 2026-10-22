import { describe, expect, it } from 'vitest';
import { suggest } from '../../src/shared/sql/complete';
import type { SqlCatalog } from '../../src/shared/ipc';

const cat: SqlCatalog = {
  tables: [
    { name: 'mst_brand', schema: 'public', kind: 'table', comment: '사업장', columns: [{ name: 'brand_seq', type: 'integer', comment: '' }, { name: 'brand_nm', type: 'varchar(100)', comment: '사업장명' }] },
    { name: 'mst_wh', schema: 'public', kind: 'table', comment: '창고', columns: [{ name: 'wh_seq', type: 'integer', comment: '' }, { name: 'brand_seq', type: 'integer', comment: '' }] },
    { name: 'v_stock', schema: 'public', kind: 'view', comment: '', columns: [{ name: 'qty', type: 'numeric', comment: '' }] },
  ],
  functions: [{ name: 'fn_lpad', args: 'text, integer', returns: 'text' }],
};
/** | 자리가 커서 */
const at = (sql: string) => { const i = sql.indexOf('|'); return suggest(sql.slice(0, i), sql.slice(i + 1), cat); };
const top = (sql: string, n = 3) => at(sql).sort((a, b) => (a.sort < b.sort ? -1 : 1)).slice(0, n).map(x => `${x.kind}:${x.label}`);

describe('SQL 자동완성 위치 판단', () => {
  it('FROM, JOIN 뒤에는 테이블과 뷰가 먼저', () => {
    expect(top('select * from |')).toEqual(['table:mst_brand', 'table:mst_wh', 'view:v_stock']);
    expect(top('select * from mst_brand b join m|')[0]).toBe('table:mst_brand');
  });

  it('SELECT, WHERE 뒤에는 이 문장에 나온 테이블의 컬럼이 먼저 (같은 컬럼은 하나로)', () => {
    expect(top('select | from mst_brand b join mst_wh w on w.brand_seq = b.brand_seq', 3))
      .toEqual(['column:brand_nm', 'column:brand_seq', 'column:wh_seq']);
    expect(top('select * from mst_wh where w|', 2)).toEqual(['column:brand_seq', 'column:wh_seq']);
  });

  it('별칭. 뒤에는 그 테이블 컬럼만, 정의 순서대로', () => {
    expect(at('select b.| from mst_brand b').map(x => x.label)).toEqual(['brand_seq', 'brand_nm']);
    expect(at('select x.| from mst_wh as x').map(x => x.label)).toEqual(['wh_seq', 'brand_seq']);
    expect(at('select * from public.|').map(x => x.label)).toEqual(['mst_brand', 'mst_wh', 'v_stock']);
  });

  it('문장 처음에는 구문 틀과 키워드', () => {
    const r = at('|');
    expect(r.filter(x => x.kind === 'snippet').map(x => x.label)).toEqual(['sel', 'selc', 'ins', 'upd', 'del']);
    expect(r.some(x => x.label === 'SELECT')).toBe(true);
    expect(top('select 1;\nup|', 1)).toEqual(['snippet:del']); // 앞 문장과 상관없이 새 문장 처음
  });

  it('DB 함수와 PostgreSQL 함수도 컬럼 자리에서 추천한다', () => {
    const r = at('select | from mst_brand');
    expect(r.find(x => x.label === 'fn_lpad')?.detail).toBe('(text, integer) text');
    expect(r.some(x => x.label === 'coalesce')).toBe(true);
  });

  it('문자열과 주석 안에서는 추천하지 않는다', () => {
    expect(at("select * from mst_brand where brand_nm = 'ab|")).toEqual([]);
    expect(at('select 1 -- from |')).toEqual([]);
    expect(at("select * from mst_brand where brand_nm = 'ab' and |").length).toBeGreaterThan(0);
  });
});
