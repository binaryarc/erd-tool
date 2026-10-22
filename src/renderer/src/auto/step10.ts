// 시험 모드 시나리오: STEP 10 편집 편의 기능. 키보드, 마우스 입력은 메인(src/main/auto/step10.ts)이 보내고 여기서 화면 상태를 읽는다 (App.vue 에서 옮김, 2026-10-22)

import { nextTick } from 'vue';
import type { FkAction, SchemaModel } from '../../../shared/model/types';
import { addColumn, addTable, dropTable } from '../../../shared/model/edit';
import { arrangeMode } from '../../../shared/model/layout';
import { diffModels } from '../../../shared/model/diff';
import { groupTabs } from '../../../shared/model/group-tabs';
import type SqlTab from '../components/SqlTab.vue';
import type { AutoCtx, AutoHelpers } from './index';

export function installStep10(app: AutoCtx, h: AutoHelpers) {
  const { activeTab, addErd, addSql, applyToDb, canRedo, canUndo, canvas, closeTab, compare, connectAsk, cur, diagram, dirty, dlg, docs, domainOpen, edit, editName, errors, flushSession, isErd, layout, membersOf, menu, message, miniName, model, openEditor, openModel, panel, pickOpen, restored, savePreview, saveTo, saveWithPreview, selectTab, selected, selectedFks, setModelDir, tab, tabNames, tabRefs, tabs, titleOf, undo, version } = app;
  const { frames, sleep } = h;

  async function step10Scenario(beDir: string, dir: string, part?: string) {
    await restored;
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    if (part === 'session2') { await nextTick(); await frames(10); await sleep(1500); return sessionState(); } // 마지막 화면으로 열린 것을 본다
    await openModel(dir);
    activeTab.value = 'erd';
    await nextTick(); await frames(10); await sleep(800);
    return { tables: model.value?.tables.length };
  }
  window.__erdProbe = (table?: string) => {
    const t = table ? model.value?.tables.find(x => x.name === table) : undefined;
    const a = document.activeElement as HTMLInputElement | null;
    return JSON.parse(JSON.stringify({
      selected: selected.value, editor: editName.value, canUndo: canUndo.value, canRedo: canRedo.value, message: message.value,
      columns: t?.columns.map(c => `${c.name} ${c.type}${c.notNull ? ' NN' : ''}`), focused: a?.tagName === 'INPUT' ? a.value : a?.tagName,
      ...groupState(),
    }));
  };
  /** 그룹 탭 상태: 보이는 탭, 탭별 소속 이름과 고정 위치, 캔버스에 그려진 테이블과 선 수, 외부 FK 배지, 열린 창 */
  function groupState() {
    const name = (id: string) => model.value?.tables.find(t => t.id === id)?.name ?? `(없음 ${id})`;
    const tabs: Record<string, { members: string[]; pinned: Record<string, [number, number]> }> = {};
    for (const n of tabNames.value) {
      const d = layout.value.diagrams[n];
      tabs[n] = { members: d.members!.map(name), pinned: Object.fromEntries(Object.entries(d.pinned).map(([id, p]) => [name(id), p])) };
    }
    const main = '.pane.canvas .split > .pane:first-child';
    return {
      tab: tab.value, tabs, modelTables: model.value?.tables.length,
      nodes: Array.from(document.querySelectorAll(`${main} .vue-flow__node-table .head b`)).map(e => e.textContent).sort(),
      edges: document.querySelectorAll(`${main} .vue-flow__edge`).length,
      extBadges: Array.from(document.querySelectorAll(`${main} .vue-flow__node-table .ext`)).map(e => `${e.closest('.head')?.querySelector('b')?.textContent}: ${e.textContent}`),
      dialog: dlg.value?.text ?? null, pick: pickOpen.value, menu: menu.value ? Array.from(document.querySelectorAll('.ctx button')).map(e => e.textContent?.trim()) : null,
      mini: miniName.value, miniTables: Array.from(document.querySelectorAll('.mini .vue-flow__node-table .head b')).map(e => e.textContent).sort(),
      dirty: dirty.value,
    };
  }
  /** 시험용: 지금 모델을 dir 에 저장하고 다시 열어 그룹 탭 상태를 저장 전과 비교한다 */
  window.__erdSaveReopen = async (dir: string) => {
    const before = groupState();
    const saved = await saveTo(dir);
    const keep = tab.value;
    await openModel(dir);
    selectTab(keep);
    await nextTick(); await frames(10); await sleep(600);
    const after = groupState();
    return JSON.parse(JSON.stringify({ written: saved?.written, before: before.tabs, after: after.tabs, same: JSON.stringify(before.tabs) === JSON.stringify(after.tabs), tab: after.tab, nodes: after.nodes }));
  };

  /** 마지막 화면 시험용: 위 탭, ERD 탭마다 모델 폴더, 저장 안 함 여부, 컬럼 수, 그룹 탭, 화면 위치, SQL 탭 글자와 접속 */
  function sessionState() {
    const erd = (id: string) => {
      const d = docs.get(id)!;
      const t = d.model.value?.tables.find(x => x.name === 'mst_brand_wh');
      return { dir: d.modelDir.value.split(/[\\/]/).pop(), title: titleOf(id), dirty: d.dirty.value, tables: d.model.value?.tables.length, whColumns: t?.columns.map(c => c.name),
        diagram: d.tab.value, groupTabs: groupTabs(d.layout.value), viewport: d === cur.value && canvas.value ? canvas.value.viewportNow() : d.viewport };
    };
    return JSON.parse(JSON.stringify({
      active: activeTab.value, cur: cur.value.id,
      tabs: tabs.value.map(t => (isErd(t.id) ? { id: t.id, ...erd(t.id) } : t.kind === 'sql'
        ? { id: t.id, title: t.title, text: (tabRefs.get(t.id) as InstanceType<typeof SqlTab> | undefined)?.text(), conn: (tabRefs.get(t.id) as InstanceType<typeof SqlTab> | undefined)?.connKey() } : { id: t.id })),
      nodes: document.querySelectorAll('.pane.canvas .split > .pane:first-child .vue-flow__node-table').length, message: message.value,
    }));
  }
  window.__erdSession = async (step: string, arg?: string) => {
    if (step === 'open') { await openModel(arg); await nextTick(); await frames(10); await sleep(600); }
    if (step === 'addErd') { addErd(); await nextTick(); }
    if (step === 'addSql') {
      const id = addSql(arg ?? '');
      await nextTick(); await frames(5);
      const tab = tabRefs.get(id) as InstanceType<typeof SqlTab>;
      await tab.loadOptions();
      await tab.connect('be:dev');
    }
    if (step === 'activate') { activeTab.value = arg!; await nextTick(); await frames(10); await sleep(800); }
    if (step === 'pan') { await canvas.value!.fitView({ nodes: [model.value!.tables.find(t => t.name === arg)!.id], maxZoom: 0.8 }); await sleep(600); }
    if (step === 'flush') await flushSession();
    return sessionState();
  };

  /**
   * 선 연결 시험 (STEP 10 완료 기준): dev 를 불러온 ERD 에 시험 테이블 mst_erd_probe 를 만들고, 메인이 실제 마우스로 선을 끌어 FK 를 만든다.
   * 그 ERD 를 dev 에 적용(커밋)하고 다시 읽어 차이 0 을 본 뒤, 되돌리기로 처음 모델로 돌아가 같은 길로 dev 에서 시험 테이블을 지운다.
   */
  const PROBE = 'mst_erd_probe';
  const mainSel = '.pane.canvas .split > .pane:first-child';
  const devRef = (beDir: string) => ({ source: 'be' as const, beDir, name: 'dev' });
  let connectBase: SchemaModel | null = null;
  window.__erdConnect = async (step: string, a?: string, b?: string) => {
    const center = (el: Element | null | undefined) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const nodeEl = (name: string) => document.querySelector(`${mainSel} .vue-flow__node-table[data-id="${model.value!.tables.find(t => t.name === name)?.id}"]`);
    const diffDev = async () => diffModels((await window.erd.db.read(devRef(a!))).model, model.value!).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}`);
    /** 지금 ERD 를 dev 에 적용: 「DB 에 적용」 → 비교 탭 「왼쪽 DB 에 적용」 → 새 SQL 탭 「전체 실행」 → 커밋 (step6 과 같은 길) */
    const applyAndCommit = async () => {
      activeTab.value = 'erd';
      await applyToDb();
      const items = compare.value!.items().map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}`);
      const before = tabs.value.length;
      compare.value!.apply();
      await nextTick(); await frames(5); await sleep(2500);
      const t = tabs.value[before];
      const tab = tabRefs.get(t.id) as InstanceType<typeof SqlTab>;
      const run = await tab.runAll();
      await tab.tx('commit');
      activeTab.value = 'erd';
      await nextTick(); await frames(10); await sleep(600);
      return { items, run };
    };
    if (step === 'prep') { // a: BE 폴더. dev 를 불러와 ERD 를 dev 와 같게 한 뒤 시험 테이블을 만든다
      await panel.value!.setSource('be'); await panel.value!.setBeDir(a!);
      panel.value!.select('dev');
      await panel.value!.doReverse();
      panel.value!.apply();
      connectBase = model.value;
      edit(m => addTable(m, PROBE, { comment: 'ERD 도구 선 연결 시험' }));
      edit(m => addColumn(m, PROBE, { name: 'probe_seq', type: 'integer', notNull: true, pk: true }));
      edit(m => addColumn(m, PROBE, { name: 'wh_seq', type: 'integer', notNull: false }));
      edit(m => addTable(m, PROBE + '_nopk', { comment: 'PK 없는 시험 테이블' }));
      edit(m => addColumn(m, PROBE + '_nopk', { name: 'memo_txt', type: 'text', notNull: false }));
      edit(m => addTable(m, PROBE + '_cpk', { comment: '복합 PK 시험 테이블' }));
      edit(m => addColumn(m, PROBE + '_cpk', { name: 'a_seq', type: 'integer', notNull: true, pk: true }));
      edit(m => addColumn(m, PROBE + '_cpk', { name: 'b_seq', type: 'integer', notNull: true, pk: true }));
      // 시험 테이블을 mst_brand 오른쪽, mst_wh 를 그 아래에 고정해 셋이 한 화면에 보이게
      await nextTick(); await frames(10);
      const boxes = canvas.value!.boxes();
      const id = (n: string) => model.value!.tables.find(t => t.name === n)!.id;
      const biz = boxes.get(id('mst_brand'))!;
      diagram.value!.pinned[id(PROBE)] = [biz.x + biz.w + 160, biz.y];
      diagram.value!.pinned[id('mst_wh')] = [biz.x + biz.w + 160, biz.y + 200];
      diagram.value!.pinned[id(PROBE + '_nopk')] = [biz.x + biz.w + 560, biz.y];
      diagram.value!.pinned[id(PROBE + '_cpk')] = [biz.x + biz.w + 560, biz.y + 200];
      version.value++;
      await nextTick(); await frames(10);
      await canvas.value!.fitView({ nodes: [id('mst_brand'), id(PROBE), id('mst_wh'), id(PROBE + '_cpk'), id(PROBE + '_nopk')], padding: 0.1 });
      await sleep(400); // 화면 맞추기가 끝난 뒤 위치를 읽게
      await sleep(800);
      return { before: await diffDev() };
    }
    if (step === 'handle') { // a 테이블, b 연결점 ID
      const h = nodeEl(a!)?.querySelector(`.vue-flow__handle[data-handleid="${b}"]`);
      const p = center(h);
      return p;
    }
    if (step === 'body') { const r = nodeEl(a!)?.getBoundingClientRect(); return r ? { x: r.x + r.width * 0.45, y: r.y + r.height - 8 } : null; } // 연결점이 아닌 몸통
    if (step === 'edge') { // a 테이블의 FK b 선 가운데
      const t = model.value!.tables.find(x => x.name === a)!;
      const path = document.querySelector<SVGPathElement>(`${mainSel} .vue-flow__edge[data-id="${t.id}:${b}"] path.vue-flow__edge-path`);
      if (!path) return null;
      const p = path.getPointAtLength(path.getTotalLength() / 2);
      const m = path.getScreenCTM()!;
      return { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
    }
    if (step === 'answer') { // 확인 창 값 고르기 (메인이 「만들기」 를 누른다)
      if (a === 'onDelete' && connectAsk.value) connectAsk.value.onDelete = b as FkAction;
      return null;
    }
    if (step === 'apply') { const r = await applyAndCommit(); return { ...r, after: await diffDev() }; }
    if (step === 'cleanup') {
      let undos = 0;
      while (canUndo.value) { undo(); undos++; }
      const r = await applyAndCommit();
      return { undos, sameAsBase: model.value === connectBase, ...r, after: await diffDev() };
    }
    const t = model.value?.tables.find(x => x.name === PROBE);
    return JSON.parse(JSON.stringify({
      columns: t?.columns.map(c => `${c.name} ${c.type}${c.notNull ? ' NN' : ''}`), fks: t?.fks, message: message.value, editor: editName.value,
      ask: connectAsk.value && { child: connectAsk.value.plan.child, parent: connectAsk.value.plan.parent, childColumn: connectAsk.value.childColumn, fkName: connectAsk.value.fkName },
      edges: document.querySelectorAll(`${mainSel} .vue-flow__edge`).length, selectedFks: selectedFks.value, canUndo: canUndo.value,
    }));
  };

  /**
   * 도메인 시험 (STEP 10 완료 기준). dir 은 시험용 빈 모델 폴더. dev 를 그 폴더로 불러오고 시험 테이블을 dev 에 만든 뒤,
   * 메인이 실제 입력으로 도메인을 만들고 연결하고 타입을 고친다. 여기서는 dev 적용, 저장, DB 직접 변경, 다시 불러오기, 정리를 한다.
   */
  window.__erdDomain = async (step: string, a?: string, b?: string) => {
    const probe = 'mst_erd_probe';
    const t = () => model.value?.tables.find(x => x.name === probe);
    const diffDev = async () => diffModels((await window.erd.db.read(devRef(a!))).model, model.value!).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}`);
    const applyAndCommit = async () => {
      activeTab.value = 'erd';
      await applyToDb();
      const items = compare.value!.items().map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}`);
      if (!items.length) return { items };
      const before = tabs.value.length;
      compare.value!.apply();
      await nextTick(); await frames(5); await sleep(2500);
      const tb = tabs.value[before];
      const tab = tabRefs.get(tb.id) as InstanceType<typeof SqlTab>;
      const run = await tab.runAll();
      await tab.tx('commit');
      activeTab.value = 'erd';
      await nextTick(); await frames(10); await sleep(600);
      return { items, run };
    };
    if (step === 'prep') { // a: BE 폴더, b: 시험용 빈 모델 폴더
      await panel.value!.setSource('be'); await panel.value!.setBeDir(a!);
      await setModelDir(b!);
      panel.value!.select('dev');
      await panel.value!.doReverse();
      panel.value!.apply();
      edit(m => addTable(m, probe, { comment: 'ERD 도구 도메인 시험' }));
      edit(m => addColumn(m, probe, { name: 'probe_seq', type: 'integer', notNull: true, pk: true }));
      edit(m => addColumn(m, probe, { name: 'a_cd', type: 'varchar(10)', notNull: false }));
      edit(m => addColumn(m, probe, { name: 'b_cd', type: 'varchar(10)', notNull: false }));
      const created = await applyAndCommit();
      openEditor(probe);
      await nextTick(); await frames(5); await sleep(400);
      return { created, after: await diffDev() };
    }
    if (step === 'editor') { openEditor(a!); await nextTick(); await frames(5); await sleep(400); return null; }
    if (step === 'apply') { const r = await applyAndCommit(); return { ...r, after: await diffDev() }; }
    if (step === 'saveTwice') { // b 폴더에 두 번 저장: 두 번째는 다시 쓴 파일이 0 이어야 바이트가 같다. 다시 열어 도메인을 본다
      const first = await saveTo(b!);
      const second = await saveTo(b!);
      await openModel(b!);
      await nextTick(); await frames(5);
      return { first: first?.written.length, second: second?.written, errors: errors.value.map(e => e.message), domains: model.value!.domains, columns: t()?.columns.map(c => `${c.name} ${c.type}${c.domain ? ' %' + c.domain : ''}`) };
    }
    if (step === 'sql') { // dev 에 SQL 한 문장을 실행하고 커밋 (도구 밖에서 DB 가 바뀐 상황 만들기)
      const id = addSql(b!);
      await nextTick(); await frames(5);
      const tab = tabRefs.get(id) as InstanceType<typeof SqlTab>;
      await tab.loadOptions();
      await tab.connect('be:dev');
      tab.editor()!.setValue(b!);
      const r = await tab.runAll();
      await tab.tx('commit');
      await closeTab(tabs.value.find(x => x.id === id)!);
      activeTab.value = 'erd';
      return r;
    }
    if (step === 'reverse') { // 같은 모델 폴더(b)로 dev 를 다시 불러온다
      panel.value!.select('dev');
      await panel.value!.doReverse();
      const p = panel.value!.pending!;
      const out = { warnings: p.warnings.filter(w => w.includes('도메인')), changed: p.diff.changed, columns: p.model.tables.find(x => x.name === probe)?.columns.map(c => `${c.name} ${c.type}${c.domain ? ' %' + c.domain : ''}`) };
      panel.value!.apply();
      return out;
    }
    if (step === 'cleanup') { // 시험 테이블을 지우는 ALTER 를 dev 에 적용
      if (t()) edit(m => dropTable(m, probe));
      const r = await applyAndCommit();
      return { ...r, after: await diffDev() };
    }
    return JSON.parse(JSON.stringify({
      domains: model.value?.domains ?? [], columns: t()?.columns.map(c => `${c.name} ${c.type}${c.domain ? ' %' + c.domain : ''}`), message: message.value,
      badges: Array.from(document.querySelectorAll(`.pane.canvas .split > .pane:first-child .vue-flow__node-table .dom`)).map(e => e.textContent),
      editor: editName.value, domainPanel: domainOpen.value, dialog: dlg.value?.text ?? null,
    }));
  };

  /** 화면 위치 저장 시험: 'set' 으로 옮기고, 'saveReopen' 으로 dir 에 저장한 뒤 같은 폴더를 다시 열어 화면 위치를 돌려준다 */
  window.__erdViewport = async (step: string, arg?: string) => {
    if (step === 'set') { const v = JSON.parse(arg!); canvas.value!.setViewportTo(v); await sleep(400); }
    if (step === 'saveReopen') {
      await saveTo(arg!);
      activeTab.value = 'erd';
      await openModel(arg!);
      await nextTick(); await frames(10); await sleep(800);
    }
    if (step === 'tab') { selectTab(arg!); await nextTick(); await frames(10); await sleep(600); }
    const v = canvas.value!.viewportNow();
    return { x: Math.round(v.x), y: Math.round(v.y), zoom: Math.round(v.zoom * 1000) / 1000, saved: diagram.value?.viewport ?? null, tab: tab.value };
  };

  /** 저장 미리보기 시험: dir 에 저장 미리보기를 띄운다 (끝을 기다리지 않는다). 메인이 창을 읽고 「저장」 을 누른다 */
  window.__erdSavePreview = async (dir: string) => {
    void saveWithPreview({ dir, hasModel: true });
    for (let i = 0; i < 50 && !savePreview.value; i++) await sleep(100);
    return !!savePreview.value;
  };

  /** 배치 되돌리기 시험 (STEP 10): 메인이 실제 입력으로 옮기고 되돌린 뒤 여기서 위치, 탭, FK 를 읽는다 */
  window.__erdUndo = async (step: string, a?: string, b?: string) => {
    const id = (n: string) => model.value!.tables.find(t => t.name === n)?.id ?? '';
    if (step === 'fit') { await canvas.value!.fitView({ nodes: a!.split(',').map(id), padding: 0.3, maxZoom: 1 }); await sleep(700); return null; }
    if (step === 'place') { // 새 테이블 a 를 b 오른쪽에 두고 둘이 보이게 (시험 준비라 되돌리기 기록에 넣지 않는다)
      const box = canvas.value!.boxes().get(id(b!))!;
      diagram.value!.pinned[id(a!)] = [box.x + box.w + 120, box.y];
      version.value++;
      await nextTick(); await frames(5);
      await canvas.value!.fitView({ nodes: [id(a!), id(b!)], padding: 0.3, maxZoom: 1 }); await sleep(700);
      return null;
    }
    const d = diagram.value!;
    const pos = (n: string) => d.pinned[id(n)] ?? null;
    const t = model.value!.tables.find(x => x.name === a);
    return JSON.parse(JSON.stringify({
      canUndo: canUndo.value, canRedo: canRedo.value, tab: tab.value, tabs: tabNames.value, mode: arrangeMode(d), pinned: Object.keys(d.pinned).length,
      pos: a ? pos(a) : null, pos2: b ? pos(b) : null, members: membersOf(tab.value)?.length ?? null,
      table: t ? { columns: t.columns.map(c => c.name), fks: t.fks.map(f => f.name) } : null, hasTable: !!t, message: message.value, ask: !!connectAsk.value,
    }));
  };


  return { step10Scenario };
}
