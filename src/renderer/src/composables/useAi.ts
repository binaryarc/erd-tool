// AI(MCP) 도구 처리 (STEP 8, 설계 10장. App.vue 에서 나눔, 2026-10-22).

import { computed, nextTick, ref } from 'vue';
import { DEFAULT_DIAGRAM } from '../../../shared/model/arrange';
import { forgetIds } from '../../../shared/model/group-tabs';
import { diffModels } from '../../../shared/model/diff';
import type { SchemaModel } from '../../../shared/model/types';
import { applyCommands } from '../../../shared/ai/commands';
import { findSpotNear } from '../../../shared/ai/place';
import { diffText, overview, tablesText, viewStateText } from '../../../shared/ai/notation';
import { buildAlter } from '../../../shared/sql/alter';
import { buildSchemaDocs } from '../../../shared/export/md';
import { buildFlyway, suggestDescription } from '../../../shared/export/flyway';
import { loadConnOptions } from '../conn-options';
import { loadTemplates } from '../md-templates';
import type { Pins } from '../erd-doc';
import { cleanError, type ErdDocs } from './useErdDocs';
import type { TopTabs } from './useTopTabs';
import type { GroupTabs } from './useGroupTabs';

export function useAi(core: ErdDocs, top: TopTabs, groups: GroupTabs) {
  const { docs, cur, model, layout, diagram, version, dirty, message, canvas, tab, shown, history, setModel, aiBase, aiStepsOf } = core;
  const { activeTab, titleOf } = top;
  const { selectTab } = groups;

  // ---------- AI(MCP) 도구 처리 (STEP 8, 설계 10장) ----------
  // 메인의 MCP 서버가 ERD 도구 호출을 여기로 넘긴다. 모델과 확정 대기 상태가 화면에 있기 때문이다.
  // AI 가 바꾼 것은 첫 변경 직전 모습(aiBase)과 비교해 주황 테두리로 강조하고, 사람이 「확정」하기 전까지 저장을 막는다.
  const pinsNow = (): Pins => ({ ...(diagram.value?.pinned ?? {}) });

  /** 확정 대기 중인 테이블 ID: 기준과 구조가 다르거나 고정 좌표가 다른 테이블 */
  const aiChanged = computed(() => {
    void version.value; // 고정 좌표는 diagram 을 직접 고치므로 version 으로 다시 계산한다
    const base = aiBase.value, m = model.value;
    if (!base || !m) return new Set<string>();
    const names = new Set(diffModels(base.model, m).map(d => d.table).filter(Boolean));
    const ids = new Set(m.tables.filter(t => names.has(t.name)).map(t => t.id));
    const pins = diagram.value?.pinned ?? {};
    for (const id of new Set([...Object.keys(pins), ...Object.keys(base.pinned)])) {
      if (String(pins[id]) !== String(base.pinned[id]) && m.tables.some(t => t.id === id)) ids.add(id);
    }
    return ids;
  });
  const nameOf = (id: string) => model.value?.tables.find(t => t.id === id)?.name ?? id;

  function needModel(): SchemaModel {
    if (!model.value || !diagram.value) throw new Error('ERD 도구에 열린 모델이 없다. 사람에게 모델 폴더를 열거나 DB 에서 불러와 달라고 하세요');
    return model.value;
  }

  function setPins(p: Pins) {
    diagram.value!.pinned = { ...p };
    version.value++;
  }

  async function aiApply(lines: string[]): Promise<string> {
    // AI 변경은 「전체」 탭에서 보여 준다. 그룹 탭이면 다른 탭에만 있는 테이블의 크기를 찾지 못한다 (STEP 10)
    if (tab.value !== DEFAULT_DIAGRAM) { selectTab(DEFAULT_DIAGRAM); await nextTick(); }
    const before = needModel();
    const beforePinned = pinsNow();
    const r = applyCommands(before, lines); // 실패하면 여기서 끝나고 아무것도 바뀌지 않는다
    const savedHistory = history.save(), wasDirty = dirty.value;
    history.push(before);
    const oldIds = new Set(before.tables.map(t => t.id));
    forgetIds(layout.value, r.model.tables.filter(t => !oldIds.has(t.id)).map(t => t.id));
    setModel(r.model);
    const placed: string[] = [];
    try {
      for (const p of r.places) {
        await nextTick();
        const ids = new Map(r.model.tables.map(t => [t.name, t.id]));
        const boxes = canvas.value!.boxes();
        const me = boxes.get(ids.get(p.table)!)!; // 바뀐 크기 (컬럼을 더했으면 더 길다)
        const spot = findSpotNear(boxes, ids.get(p.after)!, ids.get(p.table)!, { w: me.w, h: me.h });
        diagram.value!.pinned[ids.get(p.table)!] = [spot.x, spot.y];
        version.value++;
        placed.push(`${p.table} 를 ${p.after} 옆 빈 자리에 고정했다 (다른 테이블은 그대로)`);
      }
    } catch (e) {
      // 자리를 못 찾으면 전체를 되돌린다 (하나라도 실패하면 아무것도 적용하지 않는다).
      // 되돌리기 기록도 실패 전으로: undo 로 빼면 실패한 모델이 「다시 하기」 칸에 들어간다 (2026-10-22 재현)
      setModel(before);
      setPins(beforePinned);
      history.load(savedHistory);
      dirty.value = wasDirty;
      // 자리 찾기 오류는 테이블 ID(t12)로 말하므로 이름으로 바꿔 AI 에게 준다
      throw new Error((e as Error).message.replace(/\bt\d+\b/g, id => nameOf(id)));
    }
    if (!aiBase.value) aiBase.value = { model: before, pinned: beforePinned };
    aiStepsOf().push({ before, beforePinned, after: model.value! });
    version.value++;
    message.value = 'AI 가 수정했습니다 (확정 대기)';
    return [
      `적용함: 명령 ${r.done.length}줄`,
      ...placed,
      `확정 대기 중인 테이블: ${[...aiChanged.value].map(nameOf).join(', ')}`,
      '화면에 주황 테두리로 강조됐다. 사람이 「확정」해야 모델 파일에 저장된다',
    ].join('\n');
  }

  function aiUndo(): string {
    const step = aiStepsOf().at(-1);
    if (!step) throw new Error('되돌릴 AI 변경이 없다 (사람이 확정했거나 아직 고치지 않았다)');
    if (model.value !== step.after) throw new Error('그 뒤에 사람이 ERD 를 고쳐서 AI 변경만 되돌릴 수 없다');
    aiStepsOf().pop();
    history.push(model.value);
    setModel(step.before);
    setPins(step.beforePinned);
    if (!aiStepsOf().length) aiBase.value = null;
    return `마지막 erd_apply 를 되돌렸다. 남은 확정 대기 변경: ${aiStepsOf().length}번`;
  }

  /** 사람의 「확정」: 강조만 푼다 (저장은 「저장」 버튼으로) */
  function aiConfirm() {
    aiTab.value = null;
    aiBase.value = null;
    aiStepsOf().length = 0;
    version.value++;
    message.value = 'AI 변경을 확정했습니다 (저장 전)';
  }
  /** 사람의 「취소」: AI 가 고치기 전 모습으로 */
  function aiCancel() {
    const base = aiBase.value;
    if (!base || !model.value) return;
    aiTab.value = null;
    history.push(model.value);
    setModel(base.model);
    setPins(base.pinned);
    aiBase.value = null;
    aiStepsOf().length = 0;
    message.value = 'AI 변경을 취소했습니다';
  }

  async function aiExport(args: { kind?: string; conn?: string; description?: string }): Promise<string> {
    const m = needModel();
    if (aiBase.value) throw new Error('확정 대기 중인 AI 변경이 있다. 사람이 확정하거나 취소한 뒤 내보낸다');
    const s = await window.erd.settings.get();
    if (args.kind === 'md') {
      const dir = s.exportDirs?.md;
      if (!dir) throw new Error('MD 폴더가 정해지지 않았다. 사람이 내보내기 탭에서 한 번 폴더를 골라야 한다');
      const r = await window.erd.export.write(dir, buildSchemaDocs(m, new Date(), await loadTemplates()), undefined, { overwrite: true });
      return `만든 파일 ${r.written.length}개 (덮어쓴 파일 ${r.replaced.length}개)\n${r.written.join('\n')}`;
    }
    const opts = await loadConnOptions();
    const o = opts.find(x => x.profile === args.conn || x.label.startsWith(`${args.conn} (`));
    if (!o) throw new Error(`접속 ${args.conn ?? ''} 이 없다. 쓸 수 있는 접속: ${opts.map(x => x.profile ?? x.label).join(', ')}`);
    // 고르는 창이 없으므로 없는 폴더에 만들지 않는다: 기억한 폴더, 없으면 BE 에 실제로 있는 db/migration
    const dir = s.exportDirs?.flyway ?? (s.beDir ? await window.erd.export.flywayDir(s.beDir) : null);
    if (!dir) throw new Error('Flyway 폴더를 먼저 고르세요. 사람이 DB 비교 탭에서 Flyway 파일을 한 번 만들면 그 폴더를 기억한다');
    const from = (await window.erd.db.read(o.ref)).model;
    const description = args.description || suggestDescription(diffModels(from, m));
    const f = buildFlyway({ from, to: m, version: await window.erd.export.nextVersion(dir), description, fromLabel: o.label, toLabel: '지금 ERD', now: new Date() });
    const r = await window.erd.export.write(dir, [{ name: f.fileName, content: f.sql }]);
    return `만듦: ${r.written[0]} (문장 ${f.statements}개, 위험 ${f.dangers}개). DB 에는 실행하지 않았다`;
  }

  /** MCP db_compare: 두 쪽(접속 또는 지금 ERD) 구조 차이. DB 는 읽기 전용 연결로 구조만 읽는다 */
  async function aiCompare(args: { from?: string; to?: string; kind?: string; alter?: boolean }): Promise<string> {
    const opts = await loadConnOptions();
    const side = async (name = '') => {
      if (name.toLowerCase() === 'erd') {
        const m = needModel();
        return { model: m, label: aiBase.value ? '지금 ERD (확정 대기 중인 AI 변경 포함)' : '지금 ERD' };
      }
      const o = opts.find(x => x.profile === name || x.label.startsWith(`${name} (`));
      if (!o) throw new Error(`접속 ${name} 이 없다. 쓸 수 있는 것: erd, ${opts.map(x => x.profile ?? x.label).join(', ')}`);
      return { model: (await window.erd.db.read(o.ref)).model, label: o.label };
    };
    const [a, b] = await Promise.all([side(args.from), side(args.to)]);
    const all = diffModels(a.model, b.model);
    const items = args.kind ? all.filter(i => i.kind === args.kind) : all;
    const text = diffText(items, a.label, b.label) + (args.kind ? `\n(${args.kind} 만 봄. 전체 차이 ${all.length}개)` : '');
    return args.alter && items.length ? `${text}\n\n${buildAlter(a.model, b.model, items).sql}` : text;
  }

  // AI 가 쓰는 ERD 탭 (2026-10-22 재현: AI 가 읽은 뒤 사람이 다른 ERD 탭으로 옮기면 그 탭이 고쳐졌다).
  // 첫 도구 호출 때의 ERD 탭에 묶고, 그 뒤 호출은 그 탭을 화면에 띄운 다음 처리한다.
  // 확정, 취소, 그 탭 닫기, 사람이 탭 제목의 「AI 연결」 을 눌러 풀 때까지 묶어 둔다
  const aiTab = ref<string | null>(null);
  async function toAiTab() {
    if (!aiTab.value || !docs.has(aiTab.value)) aiTab.value = cur.value.id;
    if (cur.value.id === aiTab.value && activeTab.value === aiTab.value) return;
    activeTab.value = aiTab.value;
    await nextTick();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); // 캔버스가 그려져야 테이블 크기를 잰다
    message.value = `AI 가 ${titleOf(aiTab.value)} 탭에서 작업해 그 탭으로 옮겼습니다`;
  }
  /** 탭 제목의 「AI 연결」 을 눌러 푼다. 확정 대기 중인 AI 변경이 있으면 확정이나 취소가 먼저다 */
  function releaseAiTab() {
    const d = aiTab.value ? docs.get(aiTab.value) : undefined;
    if (d?.aiBase.value) { message.value = '확정 대기 중인 AI 변경을 확정하거나 취소하면 AI 연결이 풀립니다'; return; }
    aiTab.value = null;
    message.value = 'AI 연결을 풀었습니다. 다음 AI 호출은 그때 보고 있는 ERD 탭에서 합니다';
  }

  /** 도구 하나 처리. AI 가 묶인 ERD 탭을 먼저 띄운다 (시험 모드도 이것을 부른다) */
  async function runTool(tool: string, args: Record<string, unknown>): Promise<string> {
    await toAiTab();
    if (tool === 'erd_overview') return overview(needModel());
    if (tool === 'erd_tables') return tablesText(needModel(), (args.names as string[]) ?? []);
    if (tool === 'erd_view_state') { needModel(); return viewStateText(shown.value!.model, diagram.value!, canvas.value!.boxes(), canvas.value!.zoom(), tab.value); }
    if (tool === 'erd_apply') return aiApply((args.commands as string[]) ?? []);
    if (tool === 'erd_undo') return aiUndo();
    if (tool === 'erd_export') return aiExport(args);
    if (tool === 'db_compare') return aiCompare(args);
    throw new Error(`모르는 도구: ${tool}`);
  }

  let aiQueue: Promise<unknown> = Promise.resolve();
  // 도구 호출은 하나씩 처리한다 (AI 가 한꺼번에 불러도 모델이 섞이지 않게)
  window.erd.mcp.onCall((id, tool, args) => {
    aiQueue = aiQueue.then(async () => {
      try { window.erd.mcp.reply(id, { text: await runTool(tool, args) }); }
      catch (e) { window.erd.mcp.reply(id, { error: cleanError(e) }); }
    });
  });

  return { pinsNow, aiChanged, nameOf, needModel, setPins, aiApply, aiUndo, aiConfirm, aiCancel, aiExport, aiCompare, aiTab, toAiTab, releaseAiTab, runTool };
}

export type Ai = ReturnType<typeof useAi>;
