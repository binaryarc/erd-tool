// 모델 폴더 정하기, 열기, DB 에서 불러온 결과 적용, 저장 미리보기, 저장 (App.vue 에서 나눔, 2026-10-22).

import { ref } from 'vue';
import { pruneMembers } from '../../../shared/model/group-tabs';
import type { ReverseResult, SavePlan } from '../../../shared/ipc';
import { sameDir } from '../erd-doc';
import type { ErdDocs } from './useErdDocs';
import type { TopTabs } from './useTopTabs';

export function useModelFiles(core: ErdDocs, top: TopTabs) {
  const { docs, cur, modelDir, model, layout, errors, dirty, message, show, aiBase, keepViewport } = core;
  const { activeTab, titleOf } = top;

  async function setModelDir(dir: string) {
    modelDir.value = dir;
    await window.erd.settings.set({ modelDir: dir });
  }

  /** BE 폴더를 고르면 모델 폴더 기본값을 BE/docs/erd/model 로 (설계 4장 결정) */
  async function onBeDir(be: string) {
    if (!modelDir.value) await setModelDir(`${be}/docs/erd/model`);
  }

  /** 저장 안 한 ERD 변경(확정 대기 중인 AI 변경 포함)이 있으면 버려도 되는지 묻는다. 없으면 바로 true */
  function discardOk(what: string): boolean {
    if (!dirty.value && !aiBase.value) return true;
    return confirm(`저장하지 않은 ERD 변경이 있습니다${aiBase.value ? ' (확정 대기 중인 AI 변경 포함)' : ''}.\n${what} 이 변경은 사라집니다. 계속할까요?`);
  }

  async function openModel(dir?: string) {
    let d = dir;
    if (!d) {
      // 폴더 안 파일이 모두 보이는 창에서 파일 하나를 고르면 그 폴더를 연다 (2026-10-16 사용자 지정)
      const picked = await window.erd.model.pickOpen(modelDir.value || undefined);
      if (!picked) return;
      if (!picked.hasModel) { message.value = `ERD 모델 폴더가 아닙니다 (_index.erd 없음): ${picked.dir}`; return; }
      d = picked.dir;
    }
    // 다른 ERD 탭에 이미 열린 폴더면 그 탭으로 간다 (한 폴더를 두 탭에서 고치면 저장할 때 서로 덮어쓴다)
    const other = [...docs.values()].find(x => x !== cur.value && sameDir(x.modelDir.value, d) && x.model.value);
    if (other) { activeTab.value = other.id; message.value = `이미 ${titleOf(other.id)} 탭에 열려 있어 그 탭으로 이동했습니다`; return; }
    if (!discardOk('다른 ERD 를 열면')) return;
    await setModelDir(d);
    const r = await window.erd.model.load(d);
    errors.value = r.errors;
    show(r.model, r.layout);
    dirty.value = false;
    message.value = `불러왔습니다: 테이블 ${r.model.tables.length}개`;
  }

  function applyReverse(r: ReverseResult) {
    errors.value = [];
    // 모델 폴더의 기존 배치를 쓴다 (화면에 띄운 배치가 아니라). 끌어 옮긴 위치를 지키기 위해서다
    show(r.model, r.layout);
    dirty.value = true;
    message.value = `DB 에서 불러왔습니다: 테이블 ${r.model.tables.length}개 (저장 전)`;
  }

  /** 「ERD 저장」 버튼: 누를 때마다 저장할 폴더를 고른다 (2026-10-16 사용자 지정).
   *  처음 위치는 DB 접속에 쓰는 BE 폴더의 docs/erd, 없으면 사용자 홈. 다른 모델이 든 폴더를 고르면 한 번 묻는다
   *  (저장할 때 그 폴더에서 이 모델에 없는 그룹 파일을 지우기 때문) */
  async function save() {
    if (!model.value) return;
    // 사람이 확정해야 모델 파일에 저장된다 (설계 10-4)
    if (aiBase.value) { message.value = '확정 대기 중인 AI 변경을 확정하거나 취소한 뒤 저장하세요'; return; }
    const picked = await window.erd.model.pickSaveDir();
    if (!picked) return;
    return saveWithPreview(picked);
  }

  /** 고른 폴더에 저장 미리보기를 보이고, 「저장」 이면 저장한다 (시험 모드는 폴더 고르기 창 없이 이것을 부른다) */
  async function saveWithPreview(picked: { dir: string; hasModel: boolean }) {
    if (!model.value) return;
    keepViewport(); // 확대, 화면 위치도 layout.json 에 함께 저장한다 (2026-10-16 사용자 요청)
    const other = [...docs.values()].find(x => x !== cur.value && sameDir(x.modelDir.value, picked.dir));
    if (other) { message.value = `${titleOf(other.id)} 탭에 열려 있는 폴더라 저장하지 않았습니다`; return; }
    const same = sameDir(picked.dir, modelDir.value);
    // 저장하면 바뀔 파일을 먼저 보여 주고 확인을 받는다 (2026-10-16 사용자 지정). 쓰기 전 소속 정리도 복사본으로 미리 해 본다
    const l = structuredClone(layout.value);
    pruneMembers(l, model.value);
    const plan = await window.erd.model.planSave(picked.dir, JSON.parse(JSON.stringify(model.value)), l);
    if (!await askSave({ dir: picked.dir, plan, otherModel: picked.hasModel && !same })) return;
    await setModelDir(picked.dir);
    return saveTo(picked.dir);
  }

  /** 저장 미리보기 창: 새로 씀, 바뀜, 지움, 그대로 파일 목록. 「저장」 이면 true */
  const savePreview = ref<{ dir: string; plan: SavePlan; otherModel: boolean; resolve: (ok: boolean) => void } | null>(null);
  const askSave = (p: { dir: string; plan: SavePlan; otherModel: boolean }) =>
    new Promise<boolean>(resolve => { savePreview.value = { ...p, resolve }; });
  function answerSave(ok: boolean) { const p = savePreview.value; savePreview.value = null; p?.resolve(ok); }

  /** 고른 폴더에 저장 (시험 모드는 폴더 고르기 없이 이것을 부른다) */
  async function saveTo(dir: string) {
    if (!model.value) return;
    keepViewport();
    pruneMembers(layout.value, model.value); // 지운 테이블을 그룹 소속에서 정리한다 (화면에서는 되돌리기를 위해 남겨 둔다)
    const r = await window.erd.model.save(dir, model.value, layout.value);
    dirty.value = false;
    message.value = `저장했습니다 (${dir}): 바뀐 파일 ${r.written.length}개, 그대로 ${r.unchanged.length}개, 지운 파일 ${r.removed.length}개`;
    return r;
  }

  return { setModelDir, onBeDir, discardOk, openModel, applyReverse, save, saveWithPreview, savePreview, askSave, answerSave, saveTo };
}

export type ModelFiles = ReturnType<typeof useModelFiles>;
