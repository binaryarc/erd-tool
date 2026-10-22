// DB 비교 결과 MD (화면의 「MD 저장」, 「복사」)
import { describe, expect, it } from 'vitest';
import { buildCompareMd, compareMdName } from '../../src/shared/export/compare-md';
import type { DiffItem } from '../../src/shared/model/diff';

const now = new Date(2026, 9, 22, 13, 5);
const items: DiffItem[] = [
  { kind: 'table', change: 'add', table: 'mst_probe', name: 'mst_probe', detail: '2개 컬럼' },
  { kind: 'column', change: 'drop', table: 'mst_brand', name: 'old_col', detail: 'varchar(10)', danger: '컬럼 값이 사라집니다' },
  { kind: 'column', change: 'alter', table: 'mst_brand', name: 'brand_nm', detail: '타입 a | b → c', danger: undefined },
];

describe('DB 비교 결과 MD', () => {
  const md = buildCompareMd({ items, fromLabel: 'dev (shop-dev)', toLabel: '지금 ERD', now, alter: 'ALTER TABLE mst_brand DROP COLUMN old_col;\n' });

  it('머리에 두 쪽, 시각, 차이 수, 위험 수', () => {
    expect(md).toContain('- 왼쪽 (지금 모습): dev (shop-dev)\n- 오른쪽 (바꿀 모습): 지금 ERD\n- 비교 시각: 2026-10-22 13:05\n- 차이 3개, 위험 1개\n\n## 1. 요약\n');
  });
  it('요약 표와 차이 목록 표는 No. 열로 시작하고, 칸의 | 는 이스케이프한다', () => {
    expect(md).toContain('| No. | 종류 | 추가 | 삭제 | 변경 | 이름 바꿈 |');
    expect(md).toContain('| 1 | 테이블 | 1 | 0 | 0 | 0 |');
    expect(md).toContain('| 2 | 컬럼 | 0 | 1 | 1 | 0 |');
    expect(md).toContain('| 2 | 컬럼 | 삭제 | mst_brand | old_col | varchar(10) | 컬럼 값이 사라집니다 |');
    expect(md).toContain('| 3 | 컬럼 | 변경 | mst_brand | brand_nm | 타입 a \\| b → c |  |');
  });
  it('ALTER 는 sql 코드 블록으로 담는다', () => {
    expect(md).toContain('```sql\nALTER TABLE mst_brand DROP COLUMN old_col;\n```');
  });
  it('좁혀 담으면 머리에 적고, 차이가 없으면 같다고만 쓴다', () => {
    expect(buildCompareMd({ items: items.slice(1, 2), fromLabel: 'a', toLabel: 'b', now, filter: '컬럼, 위험만' })).toContain('- 차이 1개, 위험 1개\n- 좁힌 조건: 컬럼, 위험만 (보이는 줄만 담고 ALTER 는 뺌)\n');
    const same = buildCompareMd({ items: [], fromLabel: 'a', toLabel: 'b', now, alter: '-- 차이가 없다' });
    expect(same).toContain('두 쪽이 같습니다.');
    expect(same).not.toContain('| No.');
    expect(same).not.toContain('```');
  });
  it('파일 이름은 db-compare_{왼쪽}_{오른쪽}_{시각}.md, 못 쓰는 글자는 _', () => {
    expect(compareMdName('dev (shop-dev)', '지금 ERD', now)).toBe('db-compare_dev_shop-dev_지금_ERD_20261022_1305.md');
    expect(compareMdName('C:\\a\\model', 'test', now)).toBe('db-compare_C_a_model_test_20261022_1305.md');
  });
});
