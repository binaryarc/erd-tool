// 시험 모드(ERD_AUTO): 메인(src/main/auto/run.ts)이 executeJavaScript 로 부르는 window.__erd* 함수들 (App.vue 에서 옮김, 2026-10-22).
// 설치용 빌드에는 들어가지 않는다. App.vue 가 __ERD_AUTO__ 일 때만 이 파일을 불러 install 한다.

import { nextTick } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type ConnPanel from '../components/ConnPanel.vue';
import type CompareTab from '../components/CompareTab.vue';
import type TableEditor from '../components/TableEditor.vue';
import type ExportTab from '../components/ExportTab.vue';
import type ErdCanvas from '../components/ErdCanvas.vue';
import type DomainPanel from '../components/DomainPanel.vue';
import type { ConnectPlan } from '../../../shared/model/connect';
import type { FkAction as Fk, SchemaModel as Model } from '../../../shared/model/types';
import type { ViewState as View } from '../view';
import type { ErdDocs } from '../composables/useErdDocs';
import type { TopTabs } from '../composables/useTopTabs';
import type { GroupTabs } from '../composables/useGroupTabs';
import type { ModelFiles } from '../composables/useModelFiles';
import type { Ai } from '../composables/useAi';
import type { Session } from '../composables/useSession';
import { installScenarios } from './scenarios';
import { installStep10 } from './step10';

/** App.vue 에만 있는 값 (화면 요소와 App 의 작은 기능) */
export interface AppLocals {
  view: View;
  panel: Ref<InstanceType<typeof ConnPanel> | undefined>;
  compare: Ref<InstanceType<typeof CompareTab> | undefined>;
  editor: Ref<InstanceType<typeof TableEditor> | undefined>;
  exporter: Ref<InstanceType<typeof ExportTab> | undefined>;
  mini: Ref<InstanceType<typeof ErdCanvas> | undefined>;
  domainPanel: Ref<InstanceType<typeof DomainPanel> | undefined>;
  domainOpen: Ref<boolean>;
  miniModel: ComputedRef<Model | null>;
  connectAsk: Ref<{ plan: Extract<ConnectPlan, { ok: true }>; fkName: string; childColumn: string; onDelete: Fk | '' } | null>;
  selectedFks: Ref<{ table: string; fk: string }[]>;
  applyToDb(): Promise<void>;
  newTable(): Promise<void>;
  openEditor(name: string): void;
}
export type AutoCtx = ErdDocs & TopTabs & GroupTabs & ModelFiles & Ai & Session & AppLocals;
export interface AutoHelpers { frames(n: number): Promise<void>; sleep(ms: number): Promise<unknown> }

export function install(app: AutoCtx) {
  const { activeTab, canvas, model, openModel, panel, saveTo, setModelDir, view } = app;

  const frames = (n: number) => new Promise<void>(r => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  window.__erdActivate = async (id: string) => { activeTab.value = id; await nextTick(); await frames(5); await sleep(400); };

  /** SQL 탭, 터미널 탭 시험 (완료 기준 3 과 힌트 동작) */

  const h = { frames, sleep };
  const { sqlScenario, step5Scenario, step6Scenario, step7Scenario, step8Scenario, suggestScenario, passwordScenario, dbmsScenario, aiTabScenario } = installScenarios(app, h);
  const { step10Scenario } = installStep10(app, h);

  window.__erdAuto = async ({ scenario, beDir, profile, modelDir: dir, exportDir, measure, dbms, part }) => {
    if (scenario === 'step10') return step10Scenario(beDir, dir, part);
    if (scenario === 'dbms') return dbmsScenario(dir, JSON.parse(dbms ?? '[]'));
    if (scenario === 'password') return passwordScenario(beDir);
    if (scenario === 'suggest') return suggestScenario(beDir);
    if (scenario === 'mcp') { // 시험용: 모델을 열고 기다린다. 그동안 밖에서 MCP 도구를 직접 부른다 (mcp-erd.json 의 주소와 토큰)
      await panel.value!.setSource('be'); await panel.value!.setBeDir(beDir); await openModel(dir);
      await sleep(Number(measure) || 60_000);
      return { tables: model.value?.tables.length };
    }
    if (scenario === 'aitab') return aiTabScenario(beDir, dir, exportDir!);
    if (scenario === 'step8') return step8Scenario(beDir, dir, exportDir!, !!measure);
    if (scenario === 'step7') return step7Scenario(beDir, dir, exportDir!);
    if (scenario === 'step6') return step6Scenario(beDir, dir);
    if (scenario === 'step5') return step5Scenario(beDir, dir);
    if (scenario === 'sql') return sqlScenario(beDir, dir);
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    await setModelDir(dir);
    panel.value!.select(profile);
    await panel.value!.doReverse();
    const r = panel.value!.pending;
    if (!r) throw new Error('리버스 결과가 없다');
    const summary = { counts: r.counts, tables: r.model.tables.length, fks: r.model.tables.reduce((n, t) => n + t.fks.length, 0),
      functions: r.model.functions.length, sequences: r.model.sequences.length, warnings: r.warnings, hadModel: r.hadModel,
      diff: { added: r.diff.added.length, removed: r.diff.removed.length, changed: r.diff.changed.length } };
    panel.value!.apply();
    const saved = await saveTo(dir);
    await nextTick(); await frames(10); await new Promise(res => setTimeout(res, 1500));
    // 보기 모드마다 글자가 잘린 칸(이름, 논리명, 타입) 수를 센다
    const truncated: Record<string, number> = {};
    for (const mode of ['both', 'physical', 'logical'] as const) {
      view.nameMode = mode; await nextTick(); await frames(3);
      truncated[mode] = Array.from(document.querySelectorAll('.vue-flow__node-table .row > span, .vue-flow__node-table .head > *'))
        .filter(e => e.scrollWidth > e.clientWidth + 1).length;
    }
    view.nameMode = 'both'; await nextTick(); await frames(3);
    const drawn = { tableNodes: document.querySelectorAll('.vue-flow__node-table').length, edges: document.querySelectorAll('.vue-flow__edge').length, truncated };
    return { summary, saved: { written: saved?.written.length, unchanged: saved?.unchanged.length, removed: saved?.removed.length }, drawn };
  };
  // 화면 캡처 뒤 메인이 부른다: 기본 설정(컬럼 숨김 끔)으로 성능 측정
  window.__erdBench = async () => {
    const result = await canvas.value!.bench(4000, [0.15, 1.0]);
    await canvas.value!.fitView();
    return result;
  };
}
