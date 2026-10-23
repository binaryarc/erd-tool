// 키보드 단축키: Escape, Delete, Enter, Ctrl+C, Ctrl+V, Ctrl+Z, Ctrl+Y, Ctrl+` (App.vue 에서 나눔, 2026-10-23).
// 어떤 창이 떠 있을 때 어떤 키를 막는지 이 파일 한 곳에서 본다

import type { ViewState } from '../view';
import type { ErdDocs } from './useErdDocs';
import type { TopTabs } from './useTopTabs';
import type { GroupTabs } from './useGroupTabs';
import type { ModelFiles } from './useModelFiles';
import type { ConnectFk } from './useConnectFk';
import type { ColumnClipboard } from './useColumnClipboard';

export function useShortcuts(
  core: ErdDocs, top: TopTabs, groups: GroupTabs, files: ModelFiles, connect: ConnectFk, clip: ColumnClipboard, view: ViewState,
  enterColumn: (name: string) => Promise<string | undefined>,
) {
  const { model, pickId, selected, undo, redo } = core;
  const { dlg, answerDlg, activeTab, isErd, toggleTerm, pwAsk, closeAsk } = top;
  const { menu, pickOpen, deleteTables } = groups;
  const { savePreview } = files;
  const { connectAsk, selectedFks, deleteFks } = connect;

  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerm(); }
    const el = e.target as HTMLElement;
    if (e.key === 'Escape' && menu.value) { menu.value = null; return; }
    if (e.key === 'Escape' && dlg.value) { answerDlg(''); return; }
    if (e.key === 'Escape' && view.colSel.length && isErd(activeTab.value)) { view.colSel = []; return; }
    if (!isErd(activeTab.value) || pwAsk.value || closeAsk.value || dlg.value || pickOpen.value || connectAsk.value || savePreview.value) return;
    // Delete: 고른 테이블을 모델에서 지운다 (확인 창). 입력 칸 안의 Delete 는 그대로 둔다 (STEP 10)
    if (e.key === 'Delete' && !el.closest('input, textarea, select, [contenteditable]')) {
      if (selected.value.length) { e.preventDefault(); void deleteTables([...selected.value]); }
      else if (selectedFks.value.length) { e.preventDefault(); deleteFks([...selectedFks.value]); }
      return;
    }
    // Enter: 고른 테이블(없으면 편집 중인 테이블)에 컬럼을 더한다 (STEP 10). 입력 칸, 버튼 위의 Enter 는 그대로 둔다
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing && !el.closest('input, textarea, select, button, [contenteditable]')) {
      const name = model.value?.tables.find(t => t.id === pickId.value)?.name;
      if (name) { e.preventDefault(); void enterColumn(name); }
      return;
    }
    // 되돌리기, 다시 하기는 ERD 탭에서만. 입력 칸 안에서는 그 칸의 글자 되돌리기를 그대로 둔다.
    // 단 Enter 로 막 더한 컬럼 이름 칸처럼 글자를 고치지 않은 칸(data-orig 와 같은 칸)은 모델 되돌리기로 넘긴다
    // Ctrl+C, Ctrl+V: 고른 컬럼 복사, 고른 테이블에 붙이기. 입력 칸 안에서는 글자 복사 그대로
    if (e.ctrlKey && !e.shiftKey && !el.closest('input, textarea, select, [contenteditable]')) {
      const k = e.key.toLowerCase();
      if (k === 'c' && clip.copyColumns()) { e.preventDefault(); return; }
      if (k === 'v' && clip.pasteColumnsHere()) { e.preventDefault(); return; }
    }
    const untouched = el instanceof HTMLInputElement && el.dataset.orig !== undefined && el.value === el.dataset.orig;
    if (!e.ctrlKey || (!untouched && el.closest('input, textarea, select, [contenteditable]'))) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });
}
