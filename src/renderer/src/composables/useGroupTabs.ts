// 끌어 옮기기, 정렬, 그룹 탭 조작, 테이블 지우기, 우클릭 메뉴, 그룹 탭에 테이블 가져오기 (App.vue 에서 나눔, 2026-10-22).

import { computed, ref } from 'vue';
import { TabError, addMembers, createTab, deleteTab, newTabName, prefixTabs, removeMembers, renameTab } from '../../../shared/model/group-tabs';
import { dropTable } from '../../../shared/model/edit';
import { DEFAULT_DIAGRAM } from '../../../shared/model/arrange';
import { arrangeMode } from '../../../shared/model/layout';
import type { ErdDocs } from './useErdDocs';
import type { TopTabs } from './useTopTabs';

export function useGroupTabs(core: ErdDocs, top: TopTabs) {
  const { model, layout, diagram, version, dirty, fitKey, message, tab, tabNames, membersOf, refreshDiagram, snapNow, history, edit, selected, keepViewport, canvas } = core;
  const { askDlg } = top;

  /** 끌어 옮긴 테이블들 (한 번 끌기에 여러 개면 되돌리기도 한 번) */
  function onPin(pins: { id: string; x: number; y: number }[]) {
    const d = diagram.value;
    if (!d || !model.value) return;
    if (pins.every(p => String(d.pinned[p.id]) === String([p.x, p.y]))) return; // 제자리 (눌렀다 놓기만)
    history.pushSnap(snapNow());
    for (const p of pins) d.pinned[p.id] = [p.x, p.y];
    version.value++;
    dirty.value = true;
  }

  function autoArrange() {
    if (!diagram.value || !model.value) return;
    history.pushSnap(snapNow());
    diagram.value.pinned = {};
    canvas.value?.resetLayout(); // 높이만 바뀌어 지난 좌표를 쓰던 트리 배치도 처음부터
    version.value++;
    dirty.value = true;
  }

  /** 정렬 방식(트리, 그룹 격자)은 layout.json 에 다이어그램별로 저장된다. 바꾸면 끌어 옮긴 위치는 지운다 */
  function setArrangeMode(mode: 'grid' | 'tree') {
    if (!diagram.value || !model.value || arrangeMode(diagram.value) === mode) return;
    history.pushSnap(snapNow());
    diagram.value.mode = mode;
    diagram.value.pinned = {};
    canvas.value?.resetLayout();
    refreshDiagram(); // 그룹 격자 배치는 격자로 바꿀 때 만들고, 트리로 바꾸면 지운다
    version.value++;
    dirty.value = true;
  }

  function selectTab(name: string) {
    if (name !== DEFAULT_DIAGRAM && !membersOf(name)) return;
    keepViewport();
    tab.value = name;
    refreshDiagram();
    version.value++;
    fitKey.value++; // 탭을 바꾸면 그 탭에서 마지막으로 본 자리로 (없으면 전체 보기)
  }

  /** 탭 구성 바꾸기 (layout.json 만 바뀐다). 실패하면 화면 아래에 이유를 보인다 */
  function tabOp(f: () => void, done: string): boolean {
    const before = snapNow(); // 그룹 탭 조작도 되돌린다
    try { f(); }
    catch (e) { if (!(e instanceof TabError)) throw e; message.value = `할 수 없습니다: ${e.message}`; return false; }
    history.pushSnap(before);
    refreshDiagram();
    version.value++;
    dirty.value = true;
    message.value = done;
    return true;
  }
  const idsOf = (names: string[]) => names.map(n => model.value!.tables.find(t => t.name === n)?.id).filter((x): x is string => !!x);

  function addTab() {
    const name = newTabName(layout.value);
    if (tabOp(() => createTab(layout.value, name), `그룹 탭 ${name} 을(를) 만들었습니다 (저장 전). 테이블 우클릭이나 「테이블 추가」로 넣으세요`)) selectTab(name);
  }
  function onRenameTab(from: string, to: string) {
    if (tabOp(() => renameTab(layout.value, from, to), `탭 이름을 ${to}(으)로 바꿨습니다 (저장 전)`) && tab.value === from) tab.value = to;
  }
  async function onRemoveTab(name: string) {
    const n = membersOf(name)?.length ?? 0;
    if (await askDlg(`그룹 탭 「${name}」을(를) 지울까요?\n탭만 지우고 테이블 ${n}개는 모델에 그대로 남습니다.`, [{ label: '탭 지우기', value: 'ok' }, { label: '취소', value: '' }]) !== 'ok') return;
    if (tab.value === name) selectTab(DEFAULT_DIAGRAM);
    tabOp(() => deleteTab(layout.value, name), `그룹 탭 ${name} 을(를) 지웠습니다 (저장 전)`);
  }
  function onPrefixTabs() {
    let made: string[] = [];
    if (tabOp(() => { made = prefixTabs(layout.value, model.value!); }, '') ) {
      message.value = made.length ? `접두어 그룹 탭 ${made.length}개를 만들었습니다 (${made.join(', ')}, 저장 전)` : '새로 만들 접두어 그룹 탭이 없습니다';
      if (made.length) selectTab(made[0]);
    }
  }
  function addToGroup(names: string[], group: string) {
    let added: string[] = [];
    tabOp(() => { added = addMembers(layout.value, group, idsOf(names)); }, '');
    message.value = `「${group}」 탭에 ${added.length}개를 넣었습니다 (저장 전)`;
  }
  function newGroupWith(names: string[]) {
    const name = newTabName(layout.value);
    tabOp(() => createTab(layout.value, name, idsOf(names)), `「${name}」 탭을 만들어 ${names.length}개를 넣었습니다 (저장 전)`);
  }
  function removeFromGroup(names: string[]) {
    tabOp(() => removeMembers(layout.value, tab.value, idsOf(names)), `「${tab.value}」 탭에서 ${names.length}개를 뺐습니다. 모델에는 남아 있습니다 (저장 전)`);
  }

  /** 모델에서 테이블 지우기 (Delete 키, 우클릭 메뉴). 항상 확인 창에 함께 지워지는 FK 수를 보인다 (결정 13) */
  async function deleteTables(names: string[]) {
    const m = model.value;
    if (!m || !names.length) return;
    const gone = new Set(names);
    const pointing = m.tables.filter(t => !gone.has(t.name)).reduce((n, t) => n + t.fks.filter(f => gone.has(f.refTable)).length, 0);
    const own = m.tables.filter(t => gone.has(t.name)).reduce((n, t) => n + t.fks.length, 0);
    const inGroup = membersOf(tab.value) ? `\n이 그룹에서만 빼려면 취소하고 우클릭 메뉴의 「이 그룹에서 빼기」를 쓰세요.` : '';
    const text = `${names.length === 1 ? names[0] : `테이블 ${names.length}개`}을(를) 모델에서 지울까요? (모든 탭에서 없어지며 되돌릴 수 있습니다)\n`
      + `이 테이블을 가리키는 다른 테이블의 FK ${pointing}개, 이 테이블의 FK ${own}개도 함께 지웁니다.${inGroup}`;
    if (await askDlg(text, [{ label: '모델에서 삭제', value: 'ok' }, { label: '취소', value: '' }]) !== 'ok') return;
    if (edit(x => names.reduce((acc, n) => dropTable(acc, n), x))) message.value = `모델에서 지웠습니다: ${names.join(', ')} (저장 전)`;
  }

  // 우클릭 메뉴: 테이블 위면 그 테이블(고른 것 중이면 고른 것 모두), 빈 곳이면 테이블 추가
  const menu = ref<{ x: number; y: number; names: string[] } | null>(null);
  function onMenu(e: { x: number; y: number; name?: string }) {
    const names = e.name ? (selected.value.includes(e.name) ? [...selected.value] : [e.name]) : [];
    menu.value = { x: e.x, y: e.y, names };
  }
  /** 메뉴의 「그룹에 추가」 대상: 고른 테이블이 모두 들어 있지는 않은 그룹 탭 */
  const menuGroups = computed(() => {
    const mm = menu.value;
    if (!mm?.names.length || !model.value) return [];
    const ids = idsOf(mm.names);
    return tabNames.value.filter(n => n !== tab.value && !ids.every(id => membersOf(n)!.includes(id)));
  });
  /** 메뉴를 닫고 실행한다. 고른 테이블 이름은 닫기 전에 받아 둔다 */
  function runMenu(f: (names: string[]) => void) { const names = menu.value?.names ?? []; menu.value = null; f(names); }
  window.addEventListener('mousedown', e => { if (menu.value && !(e.target as HTMLElement).closest('.ctx')) menu.value = null; }, true);

  // 그룹 탭에 기존 테이블 가져오기
  const pickOpen = ref(false);
  const pickTables = computed(() => {
    void version.value;
    const mem = new Set(membersOf(tab.value) ?? []);
    return (model.value?.tables ?? []).filter(t => !mem.has(t.id)).map(t => ({ name: t.name, comment: t.comment }));
  });
  function onPick(names: string[]) {
    pickOpen.value = false;
    addToGroup(names, tab.value);
  }

  return { onPin, autoArrange, setArrangeMode, selectTab, tabOp, idsOf, addTab, onRenameTab, onRemoveTab, onPrefixTabs, addToGroup, newGroupWith, removeFromGroup, deleteTables, menu, onMenu, menuGroups, runMenu, pickOpen, pickTables, onPick };
}

export type GroupTabs = ReturnType<typeof useGroupTabs>;
