// 시험용 준비 데이터
import type { GroupRule } from '../../src/shared/model/types';

// 허브 spec/shop/_knowledge/patterns/20-database/40-schema/erd-groups.json 과 같은 규칙
export const SHOP_GROUPS: GroupRule[] = [
  { name: 'wms', prefix: 'whs_' },
  { name: 'mdm', prefix: 'mst_' },
  { name: 'sm', prefix: 'sm_', isDefault: true },
  { name: 'sif', prefix: 'sif_' },
  { name: 'wes', prefix: 'wes_' },
];
