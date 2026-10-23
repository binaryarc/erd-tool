// 선 끌어 FK 만들기, 고른 FK 선 지우기 (App.vue 에서 나눔, 2026-10-23).
// 놓으면 확인 창에서 FK 이름, 자식 컬럼(기존 또는 새 컬럼), ON DELETE 를 고른다. 새 컬럼과 FK 는 되돌리기 한 번이다.
// 그룹 탭에는 소속 테이블만 그려지므로 같은 그룹끼리만 이어진다 (결정 의 선 연결 마지막 줄)

import { ref } from 'vue';
import { dropFk } from '../../../shared/model/edit';
import { applyConnect, planConnect, type ConnectPlan, type End } from '../../../shared/model/connect';
import type { FkAction } from '../../../shared/model/types';
import type { ErdDocs } from './useErdDocs';

export function useConnectFk(core: ErdDocs, openEditor: (name: string) => void) {
  const { model, message, edit } = core;

  const canConnect = (a: End, b: End) => !!model.value && planConnect(model.value, a, b).ok;
  const connectAsk = ref<{ plan: Extract<ConnectPlan, { ok: true }>; fkName: string; childColumn: string; onDelete: FkAction | '' } | null>(null);
  const NEW_COL = ' new'; // 「새 컬럼」 고르기 값. 컬럼 이름에는 공백이 들어갈 수 없어 겹치지 않는다

  function onConnectTables(a: End, b: End) {
    if (!model.value) return;
    const plan = planConnect(model.value, a, b);
    if (!plan.ok) {
      message.value = `선으로 연결할 수 없습니다: ${plan.error}`;
      // 복합 PK 부모는 자식 쪽 편집 패널로 안내한다 (결정 9)
      if (plan.composite) {
        const ta = model.value.tables.find(t => t.name === a.table);
        const aIsParent = !!ta && ta.pk.length > 1 && (!a.column || ta.pk.includes(a.column));
        openEditor(aIsParent ? b.table : a.table);
      }
      return;
    }
    connectAsk.value = { plan, fkName: plan.fkName, childColumn: plan.childColumn ?? NEW_COL, onDelete: '' };
  }

  function answerConnect(ok: boolean) {
    const c = connectAsk.value;
    connectAsk.value = null;
    if (!ok || !c) return;
    const choice = { fkName: c.fkName.trim(), childColumn: c.childColumn === NEW_COL ? null : c.childColumn, ...(c.onDelete ? { onDelete: c.onDelete } : {}) };
    if (edit(m => applyConnect(m, c.plan, choice))) message.value = `FK ${choice.fkName} 을(를) 만들었습니다: ${c.plan.child} → ${c.plan.parent} (저장 전)`;
  }

  /** 고른 FK 선 (Delete 로 지운다) */
  const selectedFks = ref<{ table: string; fk: string }[]>([]);
  function deleteFks(fks: { table: string; fk: string }[]) {
    if (edit(m => fks.reduce((acc, f) => dropFk(acc, f.table, f.fk), m))) message.value = `FK 를 지웠습니다: ${fks.map(f => f.fk).join(', ')} (저장 전)`;
  }

  return { canConnect, connectAsk, NEW_COL, onConnectTables, answerConnect, selectedFks, deleteFks };
}

export type ConnectFk = ReturnType<typeof useConnectFk>;
