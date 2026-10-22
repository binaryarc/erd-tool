// 그룹 탭 (STEP 10): layout.json 의 다이어그램마다 소속 테이블 ID(members)와 위치(pinned)를 따로 둔다.
// 모델(.erd)은 바뀌지 않는다. 한 테이블이 여러 그룹에 들어갈 수 있다.
// 소속 목록은 화면에서 바로 정리하지 않고 저장할 때(prune) 정리한다. 테이블 삭제를 Ctrl+Z 로 되돌리면 소속도 돌아와야 해서다.
// 여기 함수는 layout 을 직접 고친다 (화면은 layout 을 shallowRef 로 들고 version 으로 다시 그린다).

import { DEFAULT_DIAGRAM } from './arrange';
import { groupOf } from './erd-format';
import type { Layout } from './layout';
import type { SchemaModel } from './types';

export class TabError extends Error {}

/** 그룹 탭 이름 목록 (화면 순서). members 가 있는 다이어그램만 */
export const groupTabs = (l: Layout): string[] => (l.tabs ?? []).filter(n => l.diagrams[n]?.members);

/** 그룹 탭에 보일 모델: 소속 테이블만. FK 는 그대로 둔다(컬럼의 FK 배지가 남는다). 캔버스는 화면에 없는 테이블로 가는 선을 그리지 않는다.
 *  external 은 그리지 않은 FK(소속 밖 테이블로 가거나 밖에서 오는 것)를 테이블 ID 별로 「→ 참조 테이블」, 「← 자식 테이블」 글자로 모은다 */
export function groupView(m: SchemaModel, members: string[]): { model: SchemaModel; external: Map<string, string[]> } {
  const ids = new Set(members);
  const inside = new Set(m.tables.filter(t => ids.has(t.id)).map(t => t.name));
  const external = new Map<string, string[]>();
  const note = (id: string, s: string) => external.set(id, [...(external.get(id) ?? []), s]);
  const idOf = new Map(m.tables.map(t => [t.name, t.id]));
  for (const t of m.tables) for (const f of t.fks) {
    const a = inside.has(t.name), b = inside.has(f.refTable);
    if (a && !b) note(t.id, `→ ${f.refTable} (${f.name})`);
    if (!a && b) note(idOf.get(f.refTable)!, `← ${t.name} (${f.name})`);
  }
  return { model: { ...m, tables: m.tables.filter(t => inside.has(t.name)) }, external };
}

function checkTabName(l: Layout, name: string, except?: string) {
  if (!name.trim()) throw new TabError('탭 이름이 비었습니다');
  if (name === DEFAULT_DIAGRAM) throw new TabError(`「${DEFAULT_DIAGRAM}」 은(는) 쓸 수 없는 이름입니다`);
  if (name !== except && l.diagrams[name]) throw new TabError(`탭 ${name} 이(가) 이미 있습니다`);
}

/** 새 그룹 탭. 배치는 트리로 시작한다 */
export function createTab(l: Layout, name: string, members: string[] = []): void {
  name = name.trim();
  checkTabName(l, name);
  l.diagrams[name] = { pinned: {}, members: [...new Set(members)] };
  l.tabs = [...(l.tabs ?? []), name];
}

/** 겹치지 않는 새 탭 이름 (그룹 1, 그룹 2, ...) */
export function newTabName(l: Layout): string {
  let i = 1;
  while (l.diagrams[`그룹 ${i}`]) i++;
  return `그룹 ${i}`;
}

export function renameTab(l: Layout, from: string, to: string): void {
  to = to.trim();
  if (to === from) return;
  if (!l.diagrams[from]?.members) throw new TabError(`그룹 탭 ${from} 이(가) 없습니다`);
  checkTabName(l, to, from);
  l.diagrams[to] = l.diagrams[from];
  delete l.diagrams[from];
  l.tabs = (l.tabs ?? []).map(n => (n === from ? to : n));
}

/** 탭만 지운다. 테이블은 모델에 남는다 */
export function deleteTab(l: Layout, name: string): void {
  if (!l.diagrams[name]?.members) throw new TabError(`그룹 탭 ${name} 이(가) 없습니다`);
  delete l.diagrams[name];
  l.tabs = (l.tabs ?? []).filter(n => n !== name);
  if (!l.tabs.length) delete l.tabs;
}

/** 소속에 넣는다. 새로 들어간 ID 만 돌려준다 */
export function addMembers(l: Layout, tab: string, ids: string[]): string[] {
  const d = l.diagrams[tab];
  if (!d?.members) throw new TabError(`그룹 탭 ${tab} 이(가) 없습니다`);
  const added = [...new Set(ids)].filter(id => !d.members!.includes(id));
  d.members = [...d.members, ...added];
  return added;
}

/** 이 그룹에서 빼기 (모델에서 지우지 않는다). 그 탭의 고정 위치도 지운다 */
export function removeMembers(l: Layout, tab: string, ids: string[]): void {
  const d = l.diagrams[tab];
  if (!d?.members) throw new TabError(`그룹 탭 ${tab} 이(가) 없습니다`);
  const out = new Set(ids);
  d.members = d.members.filter(id => !out.has(id));
  for (const id of ids) delete d.pinned[id];
}

/** 새로 생긴 테이블 ID 를 모든 그룹 소속에서 뺀다. 지운 테이블의 ID 가 새 테이블에 다시 쓰이면
 *  지운 테이블이 들어 있던 그룹에 새 테이블이 저절로 들어가는 것을 막는다 (되돌리기, 다시 하기에는 쓰지 않는다) */
export function forgetIds(l: Layout, ids: string[]): void {
  if (!ids.length) return;
  for (const n of groupTabs(l)) removeMembers(l, n, ids);
}

/** 저장, 불러오기 때: 모델에 없는 테이블 ID 를 소속에서 지운다 */
export function pruneMembers(l: Layout, m: SchemaModel): void {
  const ids = new Set(m.tables.map(t => t.id));
  for (const n of groupTabs(l)) {
    const d = l.diagrams[n];
    d.members = d.members!.filter(id => ids.has(id));
  }
  // tabs 에 없는 그룹 다이어그램(손으로 고친 파일)은 뒤에 붙여 보이게 한다
  const listed = new Set(l.tabs ?? []);
  const lost = Object.keys(l.diagrams).filter(n => l.diagrams[n].members && !listed.has(n)).sort();
  if (lost.length) l.tabs = [...(l.tabs ?? []), ...lost];
  if (l.tabs) l.tabs = l.tabs.filter(n => l.diagrams[n]?.members);
  if (l.tabs && !l.tabs.length) delete l.tabs;
}

/** 접두어 그룹(모델의 그룹 규칙, 예: mst, whs)마다 탭을 만든다. 이미 있는 이름은 건너뛴다. 만든 탭 이름을 돌려준다 */
export function prefixTabs(l: Layout, m: SchemaModel): string[] {
  const made: string[] = [];
  for (const g of m.groups) {
    if (l.diagrams[g.name] || g.name === DEFAULT_DIAGRAM) continue;
    const members = m.tables.filter(t => groupOf(t.name, m.groups) === g.name).map(t => t.id);
    if (!members.length) continue;
    createTab(l, g.name, members);
    made.push(g.name);
  }
  return made;
}
