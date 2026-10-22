// ERD 탭 상태와 수정, 되돌리기 (App.vue 에서 나눔, 2026-10-22).
// 위 탭줄의 ERD 탭마다 화면 상태(erd-doc.ts)가 따로고, 여기 값들은 지금 ERD 탭(cur)의 값을 가리킨다.

import { computed, ref, shallowRef } from 'vue';
import type ErdCanvas from '../components/ErdCanvas.vue';
import { groupTabs, groupView, pruneMembers } from '../../../shared/model/group-tabs';
import { DEFAULT_DIAGRAM, syncLayout } from '../../../shared/model/arrange';
import type { Layout } from '../../../shared/model/layout';
import type { SchemaModel } from '../../../shared/model/types';
import type { EditHistory } from '../../../shared/model/edit';
import { docField, newDoc, type ErdDoc, type Snap } from '../erd-doc';

/** IPC 오류 글에서 Electron 이 붙인 머리를 뗀다 */
export const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function useErdDocs() {
  // ---------- ERD 탭 (STEP 10 결정 20) ----------
  // 위 탭줄에 ERD 탭을 여러 개 연다. 탭마다 화면 상태(erd-doc.ts)가 따로고, 아래 값들은 지금 ERD 탭(cur)의 값을 가리킨다.
  // SQL, 비교 탭을 보고 있을 때 cur 는 마지막으로 본 ERD 탭이다 (머리 버튼, 비교, 내보내기, SQL 자동완성이 그 모델을 쓴다).
  const docs = new Map<string, ErdDoc>([['erd', newDoc('erd')]]);
  const cur = shallowRef<ErdDoc>(docs.get('erd')!);
  const modelDir = docField(cur, 'modelDir');
  const model = docField(cur, 'model');
  const layout = docField(cur, 'layout');
  const diagram = docField(cur, 'diagram');
  const version = docField(cur, 'version');
  const errors = docField(cur, 'errors');
  const dirty = docField(cur, 'dirty');
  /** 본 ERD 를 전체 보기로 맞추는 때: 모델을 불러올 때만 (고칠 때마다 화면이 튀지 않게) */
  const fitKey = docField(cur, 'fitKey');
  const message = ref('');
  const canvas = ref<InstanceType<typeof ErdCanvas>>();

  // ---------- 그룹 탭 (STEP 10) ----------
  // 보이는 다이어그램 이름. 「전체」 는 모델 전체, 그룹 탭은 소속 테이블만 거른 모델을 캔버스에 넘긴다.
  // 수정 명령은 항상 전체 모델에 적용하고, 그룹 탭 화면은 그 결과를 다시 거른다.
  const tab = docField(cur, 'tab');
  const tabNames = computed(() => { void version.value; return groupTabs(layout.value); });
  const membersOf = (name: string) => layout.value.diagrams[name]?.members;
  /** 캔버스에 넘길 모델과 그리지 않은 FK (그룹 탭일 때) */
  const shown = computed(() => {
    void version.value;
    const m = model.value;
    if (!m) return null;
    const mem = membersOf(tab.value);
    return mem ? groupView(m, mem) : { model: m, external: undefined };
  });
  /** 보이는 다이어그램을 모델에 맞춘다 (그룹 탭이면 소속 테이블만 넘겨 그 탭의 위치를 맞춘다) */
  function refreshDiagram() {
    const m = model.value;
    if (!m) return;
    const mem = membersOf(tab.value);
    diagram.value = syncLayout(mem ? groupView(m, mem).model : m, layout.value, tab.value);
  }

  function show(m: SchemaModel, l: Layout) {
    model.value = m;
    layout.value = l;
    pruneMembers(l, m);
    if (!membersOf(tab.value)) tab.value = DEFAULT_DIAGRAM;
    refreshDiagram();
    version.value++;
    fitKey.value++;
    history.clear();
    syncHistory();
    aiBase.value = null;
    aiStepsOf().length = 0;
  }

  // ---------- ERD 수정 (STEP 6) ----------
  // 수정 명령(shared/model/edit.ts)은 새 모델을 돌려준다. 되돌리기는 수정 직전 모델과 배치를 기록해 두고 바꿔 끼운다.
  // 배치(끌어 옮긴 위치, 정렬 방식, 그룹 탭)도 되돌린다 (STEP 10, 사용자 요청). 배치는 그 자리에서 고쳐 쓰므로 복사해 담는다
  const snapNow = (m = model.value!): Snap => ({ model: m, layout: structuredClone(layout.value) });
  const history = {
    /** 수정 직전 모델 (배치는 지금 것을 복사해 함께 담는다) */
    push: (m: SchemaModel) => { cur.value.history.push(snapNow(m)); },
    pushSnap: (s: Snap) => { cur.value.history.push(s); syncHistory(); },
    undo: (m: SchemaModel) => cur.value.history.undo(snapNow(m)),
    redo: (m: SchemaModel) => cur.value.history.redo(snapNow(m)),
    clear: () => cur.value.history.clear(),
    save: () => cur.value.history.save(),
    load: (h: ReturnType<EditHistory<Snap>['save']>) => { cur.value.history.load(h); syncHistory(); },
    get canUndo() { return cur.value.history.canUndo; },
    get canRedo() { return cur.value.history.canRedo; },
  };
  const canUndo = docField(cur, 'canUndo');
  const canRedo = docField(cur, 'canRedo');
  function syncHistory() { canUndo.value = history.canUndo; canRedo.value = history.canRedo; }

  /** 편집 패널에 띄운 테이블 ID. 이름이 아니라 ID 로 들고 있어야 이름을 바꾸거나 되돌려도 패널이 따라간다 */
  const editId = docField(cur, 'editId');
  const editName = computed(() => model.value?.tables.find(t => t.id === editId.value)?.name ?? '');

  function setModel(m: SchemaModel) {
    model.value = m;
    refreshDiagram();
    version.value++;
    dirty.value = true;
    syncHistory();
    if (miniName.value && !m.tables.some(t => t.name === miniName.value)) miniName.value = '';
  }

  function edit(fn: (m: SchemaModel) => SchemaModel, done?: (ok: boolean) => void, note?: string): boolean {
    if (!model.value) { done?.(false); return false; }
    let next: SchemaModel;
    try { next = fn(model.value); }
    catch (e) { message.value = `수정하지 못했습니다: ${(e as Error).message}`; done?.(false); return false; }
    if (next !== model.value) {
      history.push(model.value);
      setModel(next);
      message.value = note ?? '수정했습니다 (저장 전)';
    }
    done?.(true);
    return true;
  }

  /** 되돌리기 한 칸을 화면에 놓는다. 보던 그룹 탭이 없어졌으면 「전체」 로 */
  function restore(s: Snap) {
    layout.value = s.layout;
    if (!membersOf(tab.value)) tab.value = DEFAULT_DIAGRAM;
    setModel(s.model);
  }
  function undo() {
    const s = model.value && history.undo(model.value);
    if (s) { restore(s); message.value = '되돌렸습니다'; }
  }
  function redo() {
    const s = model.value && history.redo(model.value);
    if (s) { restore(s); message.value = '다시 실행했습니다'; }
  }

  /** Enter 로 컬럼을 더할 테이블 ID: 마지막으로 하나만 고른 테이블이나 편집 패널에 연 테이블 중 나중 것 (STEP 10).
   *  새 테이블을 만든 직후 캔버스에 다른 테이블이 골라져 있어도 새 테이블로 간다 */
  const pickId = docField(cur, 'pickId');

  const aiBase = docField(cur, 'aiBase');
  /** 지금 ERD 탭의 AI 변경 단계 (배열을 그 자리에서 고친다) */
  const aiStepsOf = () => cur.value.aiSteps;

  // 미니 ERD 가운데 테이블
  const miniName = docField(cur, 'miniName');
  /** 캔버스에서 고른 테이블 이름 */
  const selected = ref<string[]>([]);

  /** 지금 화면 위치를 보이는 다이어그램에 적어 둔다 (탭을 떠날 때, 저장할 때). 배율은 소수 셋째 자리, 위치는 정수 */
  function keepViewport() {
    const v = canvas.value?.viewportNow();
    if (v && diagram.value) diagram.value.viewport = { x: Math.round(v.x), y: Math.round(v.y), zoom: Math.round(v.zoom * 1000) / 1000 };
  }

  return { docs, cur, modelDir, model, layout, diagram, version, errors, dirty, fitKey, message, canvas, tab, tabNames, membersOf, shown, refreshDiagram, show, snapNow, history, canUndo, canRedo, syncHistory, editId, editName, setModel, edit, restore, undo, redo, pickId, aiBase, aiStepsOf, miniName, selected, keepViewport };
}

export type ErdDocs = ReturnType<typeof useErdDocs>;
