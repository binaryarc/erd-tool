// 시험용 준비 데이터
import type { GroupRule } from '../../src/shared/model/types';

// 접두어 그룹 규칙 예 (테이블 이름 접두어로 그룹을 나눈다)
export const SAMPLE_GROUPS: GroupRule[] = [
  { name: 'whs', prefix: 'whs_' },
  { name: 'mst', prefix: 'mst_' },
  { name: 'sys', prefix: 'sys_', isDefault: true },
  { name: 'sio', prefix: 'sio_' },
  { name: 'wcs', prefix: 'wcs_' },
];
