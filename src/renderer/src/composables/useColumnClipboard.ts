// 컬럼 고르기, 복사, 붙여넣기 (App.vue 에서 나눔, 2026-10-23. 기능은 2026-10-16 사용자 요청).
// 컬럼 행을 누르면 고르고(Shift, Ctrl 로 더하기), Ctrl+C 로 복사, 붙일 테이블을 고르고 Ctrl+V 로 그 테이블 맨 아래에 붙인다.
// 복사한 컬럼은 다른 ERD 탭(다른 모델)에도 붙일 수 있다. 같은 이름이 있으면 건너뛴다

import { pasteColumns } from '../../../shared/model/edit';
import type { Column } from '../../../shared/model/types';
import { columnText } from '../../../shared/model/erd-format';
import { colKey, type ViewState } from '../view';
import type { ErdDocs } from './useErdDocs';

const NL = '\n';

// 모듈 변수: 탭을 바꿔도 남아서 다른 ERD 탭에 붙일 수 있다
let colClipboard: { from: string; columns: Column[] } | null = null;

export function useColumnClipboard(core: ErdDocs, view: ViewState) {
  const { model, message, edit, pickId } = core;

  view.onColumnClick = (table, column, add) => {
    const k = colKey(table, column);
    view.colSel = add ? (view.colSel.includes(k) ? view.colSel.filter(x => x !== k) : [...view.colSel, k]) : [k];
  };

  function copyColumns(): boolean {
    const m = model.value;
    if (!m || !view.colSel.length) return false;
    const cols = view.colSel.map(k => { const [t, c] = k.split('\t'); return m.tables.find(x => x.name === t)?.columns.find(x => x.name === c); })
      .filter((c): c is Column => !!c).map(c => ({ ...c }));
    if (!cols.length) return false;
    const from = [...new Set(view.colSel.map(k => k.split('\t')[0]))].join(', ');
    colClipboard = { from, columns: cols };
    // 글로도 복사해 둔다 (메모장, 메신저에 붙일 때). 한 줄에 컬럼 하나, 모델 파일 표기
    void navigator.clipboard?.writeText(cols.map(c => columnText(c, false)).join(NL)).catch(() => undefined);
    message.value = `컬럼 ${cols.length}개를 복사했습니다 (${from}). 붙일 테이블을 고르고 Ctrl+V 를 누르세요`;
    return true;
  }

  function pasteColumnsHere(): boolean {
    if (!colClipboard || !model.value) return false;
    const target = model.value.tables.find(t => t.id === pickId.value)?.name;
    if (!target) { message.value = '붙일 테이블을 먼저 고르세요'; return true; }
    let r: ReturnType<typeof pasteColumns> | null = null;
    const clip = colClipboard;
    if (!edit(m => { r = pasteColumns(m, target, clip.columns); return r.model; })) return true;
    const res = r as ReturnType<typeof pasteColumns> | null;
    if (!res) return true;
    view.colSel = res.added.map(c => colKey(target, c));
    message.value = res.added.length
      ? `${target} 에 컬럼 ${res.added.length}개를 붙였습니다${res.skipped.length ? ` (같은 이름이 있어 건너뜀: ${res.skipped.join(', ')})` : ''}`
      : `붙일 컬럼이 없습니다. ${target} 에 같은 이름이 모두 있습니다 (${res.skipped.join(', ')})`;
    return true;
  }

  return { copyColumns, pasteColumnsHere };
}

export type ColumnClipboard = ReturnType<typeof useColumnClipboard>;
