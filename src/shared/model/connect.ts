// 테이블끼리 선을 끌어 FK 만들기 (STEP 10). 화면은 끌기 시작한 쪽(a)과 놓은 쪽(b)만 알려 준다.
// 어느 쪽이 부모인지는 PK, UNIQUE 로 정한다 (사람은 방향을 몰라도 된다). 둘 다 부모가 될 수 있으면 끌기 시작한 쪽이 부모다.
// 부모 키가 복합 PK 이면 1차에서는 오류로 안내하고 편집 패널을 쓰게 한다 (결정 9).

import { addColumn, addFk, defaultFkName } from './edit';
import type { FkAction, SchemaModel, Table } from './types';

/** 선의 한쪽 끝: 테이블 이름과 컬럼 이름. 컬럼이 없으면 테이블 머리나 몸통에 놓은 것이다 */
export interface End { table: string; column?: string }

export type ConnectPlan =
  | {
    ok: true;
    parent: string; parentColumn: string; parentType: string;
    child: string;
    /** 처음 고른 자식 컬럼. null 이면 새로 만든다 (newColumn 이름으로) */
    childColumn: string | null;
    newColumn: string;
    /** 자식 컬럼으로 고를 수 있는 기존 컬럼 */
    childOptions: { name: string; type: string }[];
    fkName: string;
  }
  | { ok: false; error: string; composite?: boolean };

const sameCols = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

/** 이 끝이 부모 키가 될 수 있나: 단일 PK, 단일 UNIQUE 제약, 단일 UNIQUE 인덱스. 복합 PK 면 'composite' */
function keyOf(t: Table, column?: string): string | 'composite' | null {
  if (!column) return t.pk.length === 1 ? t.pk[0] : t.pk.length > 1 ? 'composite' : null;
  if (sameCols(t.pk, [column])) return column;
  if (t.uniques.some(u => sameCols(u.columns, [column])) || t.indexes.some(i => i.unique && sameCols(i.columns, [column]))) return column;
  if (t.pk.includes(column)) return 'composite';
  return null;
}

export function planConnect(m: SchemaModel, a: End, b: End): ConnectPlan {
  const ta = m.tables.find(t => t.name === a.table), tb = m.tables.find(t => t.name === b.table);
  if (!ta || !tb) return { ok: false, error: '테이블을 찾지 못했습니다' };
  if (ta === tb && (!a.column || !b.column || a.column === b.column)) return { ok: false, error: '같은 테이블 안에서는 서로 다른 두 컬럼을 이어야 합니다 (자기 참조 FK)' };
  const ka = keyOf(ta, a.column), kb = keyOf(tb, b.column);
  let parent: Table, key: string, child: Table, childEnd: End;
  if (ka && ka !== 'composite') { parent = ta; key = ka; child = tb; childEnd = b; }
  else if (kb && kb !== 'composite') { parent = tb; key = kb; child = ta; childEnd = a; }
  else if (ka === 'composite' || kb === 'composite') {
    const p = ka === 'composite' ? ta : tb;
    return { ok: false, composite: true, error: `${p.name} 의 PK 가 복합 키(${p.pk.join(', ')})라 선으로는 만들 수 없습니다. 자식 테이블의 편집 패널에서 FK 를 추가하세요` };
  } else return { ok: false, error: `${ta.name}, ${tb.name} 둘 다 이 컬럼이 PK 나 UNIQUE 가 아니라 FK 로 가리킬 수 없습니다` };

  const pcol = parent.columns.find(c => c.name === key)!;
  const options = child.columns.filter(c => !(child === parent && c.name === key)).map(c => ({ name: c.name, type: c.type }));
  // 자식 컬럼 처음 값: 같은 이름 컬럼 → 놓은 컬럼(타입이 같고 아직 FK 가 아닐 때) → 새 컬럼 (결정 8)
  const fkCols = new Set(child.fks.flatMap(f => f.columns));
  const same = options.find(c => c.name.toLowerCase() === key.toLowerCase());
  const dropped = childEnd.column ? options.find(c => c.name === childEnd.column && c.type === pcol.type && !fkCols.has(c.name)) : undefined;
  return {
    ok: true, parent: parent.name, parentColumn: key, parentType: pcol.type, child: child.name,
    childColumn: same?.name ?? dropped?.name ?? null, newColumn: key, childOptions: options,
    fkName: defaultFkName(m, child.name, parent.name),
  };
}

/** 확인 창에서 고른 값으로 FK 를 만든다. 새 컬럼이 필요하면 부모 키와 같은 타입, NULL 허용으로 먼저 더한다 (한 번의 수정) */
export function applyConnect(m: SchemaModel, plan: Extract<ConnectPlan, { ok: true }>, choice: { fkName: string; childColumn: string | null; onDelete?: FkAction }): SchemaModel {
  let col = choice.childColumn;
  if (col === null) {
    m = addColumn(m, plan.child, { name: plan.newColumn, type: plan.parentType, notNull: false });
    col = m.tables.find(t => t.name === plan.child)!.columns.find(c => c.name.toLowerCase() === plan.newColumn.toLowerCase())!.name;
  }
  return addFk(m, plan.child, {
    name: choice.fkName, columns: [col], refTable: plan.parent, refColumns: [plan.parentColumn],
    ...(choice.onDelete ? { onDelete: choice.onDelete } : {}),
  });
}
