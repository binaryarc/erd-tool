// 시험 모드 시나리오: SQL 탭, DB 비교와 적용(STEP 5), ERD 수정(STEP 6), 내보내기(STEP 7), AI(STEP 8), 자동완성, 비밀번호 창, 여러 DB (App.vue 에서 옮김, 2026-10-22)

import { nextTick } from 'vue';
import type { ConnRef, ManualConn } from '../../../shared/ipc';
import { addColumn, addFk, addTable, updateTable } from '../../../shared/model/edit';
import { arrangeMode } from '../../../shared/model/layout';
import { buildJoinSelect } from '../../../shared/sql/join';
import { diffModels } from '../../../shared/model/diff';
import { overview } from '../../../shared/ai/notation';
import type { ViewState } from '../view';
import type SqlTab from '../components/SqlTab.vue';
import type { AutoCtx, AutoHelpers } from './index';

export function installScenarios(app: AutoCtx, h: AutoHelpers) {
  const { activeTab, addSql, addTerm, aiBase, aiCancel, answerPw, applyReverse, applyToDb, canRedo, canUndo, canvas, compare, diagram, edit, editName, editor, exporter, message, miniModel, miniName, model, nameOf, newTable, openCompare, openEditor, openExport, openModel, panel, pwAsk, pwInput, redo, saveTo, setArrangeMode, setModelDir, tabRefs, tabs, terminals, undo, view, aiChanged, addErd, docs, runTool, aiTab, titleOf } = app;
  const { frames, sleep } = h;

  async function sqlScenario(beDir: string, dir: string) {
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    await openModel(dir);
    const out: Record<string, unknown> = {};

    const id = addSql();
    await nextTick(); await frames(5);
    type SqlTabApi = InstanceType<typeof SqlTab>;
    const tab = tabRefs.get(id) as SqlTabApi;
    await tab.loadOptions();
    await tab.connect('be:dev');
    out.connect = { options: tab.options(), message: tab.message(), state: tab.state() };
    const ed = tab.editor()!;
    ed.setValue('select g as n, md5(g::text) as h from generate_series(1, 2500) g');
    await tab.run();
    await frames(5); await sleep(300);
    out.grid = { ...tab.grid(), state: tab.state() };

    // 자동완성: 목록을 여는 명령 없이 글자만 쳤을 때 저절로 뜨는지 (DBeaver 처럼)
    await sleep(1500); // 접속한 DB 목록 읽기
    out.catalogTables = tab.catalogSize();
    /** text 를 한 글자씩 친다. suffix 를 주면 커서 뒤에 그 글자가 이미 있는 상태에서 친다 */
    const typeAndRead = async (text: string, suffix = '') => {
      ed.setValue(suffix);
      ed.setPosition({ lineNumber: 1, column: 1 });
      ed.focus();
      for (const ch of text) ed.trigger('keyboard', 'type', { text: ch });
      await sleep(900);
      const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')).slice(0, 4).map(r => r.getAttribute('aria-label'));
      ed.trigger('auto', 'hideSuggestWidget', {});
      return rows;
    };
    out.suggest = {
      afterFrom: await typeAndRead('select * from mst_b'),
      afterAliasDot: await typeAndRead('select b.', ' from mst_brand b'),
      afterWhere: await typeAndRead('select * from mst_brand b where bi'),
      start: await typeAndRead('se'),
    };

    // 회색 미리보기: 방금 실행한 문장이 이력에 (리터럴은 ?) 있다
    ed.setValue('select g as');
    ed.setPosition({ lineNumber: 1, column: 12 });
    ed.trigger('auto', 'editor.action.inlineSuggest.trigger', {});
    await sleep(1000);
    out.ghost = Array.from(document.querySelectorAll('[class*=ghost-text]')).map(e => e.textContent).join('');

    // ERD 에서 고른 테이블로 SELECT 만들어 실행
    const join = buildJoinSelect(model.value!, ['mst_brand_wh', 'mst_brand', 'mst_wh']);
    ed.setValue(join);
    ed.setSelection(ed.getModel()!.getFullModelRange());
    const jr = await tab.run();
    out.join = { sql: join, columns: jr?.columns.length, error: tab.state() ? undefined : 'no state' };
    ed.setPosition({ lineNumber: 1, column: 1 });

    // 아래 터미널 영역: PowerShell 에서 claude --version, 한글 폭, 시작 폴더(사용자 홈)
    const tid = await addTerm('powershell');
    await nextTick(); await sleep(3000);
    const term = terminals.value!.get(tid)!;
    term.write('claude --version\r');
    await sleep(8000);
    term.write('echo 가나다ABC\r');
    await sleep(500);
    term.write('(Get-Location).Path\r');
    await sleep(1500);
    const buf = term.bufferText();
    out.terminal = { claude: /\(Claude Code\)/.test(buf), korean: buf.includes('가나다ABC'), tail: buf.split('\n').slice(-6),
      tabTitle: terminals.value!.terms.find(t => t.id === tid)?.title };
    // 실행 중에 터미널 하나를 닫아도 오류가 없어야 한다
    const t2 = await addTerm('bash');
    await sleep(2500);
    terminals.value!.close(t2);
    terminals.value!.activate(tid);
    await sleep(1500);
    // 위(ERD)와 아래(터미널)가 같이 보이는지: 두 영역의 화면 위치
    activeTab.value = 'erd';
    await nextTick(); await frames(5);
    const top = document.querySelector('.main-top')?.getBoundingClientRect();
    const bottom = document.querySelector('.term-panel')?.getBoundingClientRect();
    out.layout = { topHeight: Math.round(top?.height ?? 0), bottomTop: Math.round(bottom?.top ?? 0), bottomHeight: Math.round(bottom?.height ?? 0) };
    out.tabs = { sql: id, erd: 'erd' };
    activeTab.value = id;
    return JSON.parse(JSON.stringify(out)); // 반응형 값이 섞여 있어 평범한 값으로 바꿔 돌려준다
  }

  // ERD 보기 시험용 (메인이 실제 마우스 입력과 함께 부른다)
  window.__erdView = async (opts: { mode?: 'grid' | 'tree'; edge?: ViewState['edgeKind'] }) => {
    if (opts.mode) setArrangeMode(opts.mode);
    if (opts.edge) view.edgeKind = opts.edge;
    await nextTick(); await frames(10); await sleep(600);
    // 겹치는 테이블 쌍 수 (화면 위치 기준)
    const boxes = Array.from(document.querySelectorAll('.pane.canvas .split > .pane:first-child .vue-flow__node-table'))
      .map(e => e.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++;
    }
    return { mode: diagram.value && arrangeMode(diagram.value), edge: view.edgeKind, tables: boxes.length, overlaps };
  };
  /** 본 ERD 에서 이름으로 테이블 노드 화면 위치 (머리 부분). 먼저 그 테이블로 화면을 옮긴다 */
  window.__erdNodeRect = async (name: string) => {
    await canvas.value?.focusTable(name);
    await sleep(600);
    const node = Array.from(document.querySelectorAll('.pane.canvas .split > .pane:first-child .vue-flow__node-table'))
      .find(e => e.querySelector('.head b')?.textContent === name);
    const r = node?.querySelector('.head')?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  };
  window.__erdInspect = () => ({
    selected: Array.from(document.querySelectorAll('.vue-flow__node-table.selected .head b')).map(e => e.textContent),
    selectedOutline: getComputedStyle(document.querySelector('.vue-flow__node-table.selected .tbl') ?? document.body).outlineWidth,
    mini: miniName.value,
    miniTables: Array.from(document.querySelectorAll('.mini .vue-flow__node-table .head b')).map(e => e.textContent).sort(),
    expected: miniModel.value?.tables.map(t => t.name).sort() ?? [],
    badges: { pk: document.querySelectorAll('.key .pk').length, fk: document.querySelectorAll('.key .fk').length, nn: document.querySelectorAll('.key .nn').length },
  });
  window.__erdGrid = () => {
    const row = document.querySelector('.ag-row');
    const cell = document.querySelector('.ag-cell');
    const body = document.querySelector('.ag-body-viewport');
    return { rowHeight: row?.getBoundingClientRect().height, fontSize: cell ? getComputedStyle(cell).fontSize : null,
      visibleRows: body && row ? Math.floor(body.clientHeight / row.getBoundingClientRect().height) : null };
  };

  /** STEP 5 시험: DB 비교(dev 대 test), ERD 차이를 dev 에 적용(전체 실행) 후 롤백 */
  async function step5Scenario(beDir: string, dir: string) {
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    await openModel(dir);
    const out: Record<string, unknown> = {};

    openCompare();
    await nextTick(); await frames(5);
    compare.value!.setLeft('be:dev');
    compare.value!.setRight('be:test');
    await sleep(300);
    out.devVsTest = await compare.value!.compare();
    await nextTick(); await frames(5); await sleep(300);

    // ERD 에만 컬럼 하나를 더한다 (화면 모델만, 파일 저장 안 함) → dev 와 비교 → dev 에 적용 → 전체 실행 → 롤백
    const original = model.value!;
    const probe = 'erd_tool_probe';
    model.value = { ...original, tables: original.tables.map(t => t.name === 'mst_brand' ? { ...t, columns: [...t.columns, { name: probe, type: 'varchar(10)', notNull: false }] } : t) };
    compare.value!.setRight('be:dev');
    compare.value!.setLeft('be:dev');
    await sleep(200);
    // 왼쪽 dev, 오른쪽 지금 ERD
    compare.value!.setRightErd();
    out.devVsErd = await compare.value!.compare();
    out.alter = compare.value!.alter().split('\n').filter(l => l && !l.startsWith('--'));
    const before = tabs.value.length;
    compare.value!.apply();
    await nextTick(); await frames(5); await sleep(2500); // 새 SQL 탭이 dev 에 접속
    const sqlTab = tabs.value[before];
    const tab = tabRefs.get(sqlTab.id) as InstanceType<typeof SqlTab>;
    out.applyTab = { title: sqlTab.title, conn: sqlTab.initialConn, state: tab.state() };
    out.runAll = await tab.runAll();
    out.afterRun = tab.state();
    const check = await window.erd.sql.run(sqlTab.id, `select ${probe} from mst_brand limit 0`);
    out.columnExistsInTx = !check.error;
    await tab.tx('rollback');
    const after = await window.erd.sql.run(sqlTab.id, `select ${probe} from mst_brand limit 0`);
    out.columnGoneAfterRollback = !!after.error && /does not exist/.test(after.error.message);
    await tab.tx('rollback');
    model.value = original;
    activeTab.value = sqlTab.id;
    out.tabs = { apply: sqlTab.id };
    return JSON.parse(JSON.stringify(out));
  }

  /**
   * STEP 6 시험 (완료 기준): 화면에서 새 테이블에 컬럼을 추가하고 FK 를 만든 뒤 dev 에 적용(커밋)하고 다시 불러오면 차이 0.
   * 끝에 되돌리기로 수정 전 모델로 돌아가 같은 길로 dev 에 적용(커밋)해 시험 테이블을 지우고, dev 가 수정 전과 같은지 다시 본다.
   * 기존 테이블은 건드리지 않고 시험 테이블(mst_erd_probe)만 만들었다 지운다. 모델 파일은 저장하지 않는다.
   */
  async function step6Scenario(beDir: string, dir: string) {
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    await openModel(dir);
    const out: Record<string, unknown> = {};
    const devRef = { source: 'be' as const, beDir, name: 'dev' };
    const diffDev = async () => diffModels((await window.erd.db.read(devRef)).model, model.value!).map(d => `${d.kind} ${d.change} ${d.table ?? ''}.${d.name}`);
    const original = model.value!;
    out.before = await diffDev(); // 모델 폴더와 dev 가 처음부터 같아야 시험이 뜻이 있다
    const probe = 'mst_erd_probe';

    /** 지금 ERD 를 dev 에 적용: 「DB 에 적용」 → 비교 탭 「왼쪽 DB 에 적용」 → 새 SQL 탭 「전체 실행」 → 커밋 */
    const applyAndCommit = async () => {
      activeTab.value = 'erd';
      await applyToDb();
      const items = compare.value!.items().map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}`);
      const before = tabs.value.length;
      compare.value!.apply();
      await nextTick(); await frames(5); await sleep(2500); // 새 SQL 탭이 dev 에 접속
      const t = tabs.value[before];
      const tab = tabRefs.get(t.id) as InstanceType<typeof SqlTab>;
      const run = await tab.runAll();
      await tab.tx('commit');
      return { items, tab: t.id, run, after: tab.state() };
    };

    try {
      activeTab.value = 'erd';
      await newTable();
      await nextTick(); await frames(5);
      const tempName = editName.value;
      edit(m => updateTable(m, tempName, { name: probe, comment: 'ERD 도구 시험' }));
      await nextTick(); await frames(3);
      editor.value!.addColumnDraft({ name: 'probe_seq', type: 'int', pk: true, comment: '시험 SEQ' });
      await nextTick();
      editor.value!.addColumnDraft({ name: 'brand_seq', type: 'integer', comment: '사업장' });
      await nextTick();
      editor.value!.addFkDraft('mst_brand', ['brand_seq']);
      await nextTick(); await frames(10); await sleep(800);
      const t = model.value!.tables.find(x => x.name === probe)!;
      out.edited = { tempName, editor: editName.value, columns: t.columns.map(c => `${c.name} ${c.type}${c.notNull ? ' NN' : ''}`), pk: t.pk, fks: t.fks,
        node: Array.from(document.querySelectorAll('.vue-flow__node-table .head b')).some(e => e.textContent === probe),
        edge: !!document.querySelector(`.vue-flow__edge[data-id="${t.id}:${t.fks[0]?.name}"]`), canUndo: canUndo.value, message: message.value };
      // 잘못된 수정은 막히고 모델은 그대로
      const bad = edit(m => updateTable(m, probe, { name: 'mst_brand' }));
      out.badEdit = { applied: bad, message: message.value };
      out.apply = await applyAndCommit();
      out.afterApply = await diffDev(); // 다시 불러오면 차이 0 (완료 기준)
    } finally {
      // 되돌리기로 수정 전 모델로 → 같은 길로 dev 에 적용해 시험 테이블을 지운다
      let undos = 0;
      while (canUndo.value) { undo(); undos++; }
      out.undo = { undos, sameAsOriginal: model.value === original };
      out.cleanup = await applyAndCommit();
      out.afterCleanup = await diffDev();
      activeTab.value = 'erd';
    }
    return JSON.parse(JSON.stringify(out));
  }

  /** STEP 6 화면 캡처용: 되돌린 수정을 다시 하기로 되살려 편집 패널과 함께 보여준다 (DB 는 건드리지 않는다) */
  window.__erdStep6Shot = async () => {
    let redos = 0;
    while (canRedo.value) { redo(); redos++; }
    activeTab.value = 'erd';
    openEditor('mst_erd_probe');
    await nextTick(); await frames(5);
    await canvas.value?.focusTable('mst_erd_probe');
    await frames(10); await sleep(800);
    return { redos, editor: editName.value };
  };

  /**
   * STEP 7 시험: ERD 를 고친 뒤 dev 와 비교해 Flyway 파일과 이력 한 줄을 만들고, MD 문서와 메뉴 물리 테이블 목록을 만든다.
   * 파일은 모두 exportDir(시험용 임시 폴더)에 쓴다. BE 의 db/migration 은 다음 번호만 읽는다. DB 는 읽기만 한다.
   */
  async function step7Scenario(beDir: string, dir: string, exportDir: string) {
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    await openModel(dir);
    const out: Record<string, unknown> = {};
    activeTab.value = 'erd';
    out.arrange = await window.__erdView!({}); // 배치 방식이 적혀 있지 않은 모델은 트리로 열린다
    const probe = 'mst_erd_probe';
    edit(m => addTable(m, probe, { comment: 'ERD 도구 시험', withCommon: true }));
    edit(m => addColumn(m, probe, { name: 'probe_seq', type: 'int', notNull: false, pk: true }));
    edit(m => addColumn(m, probe, { name: 'brand_seq', type: 'integer', notNull: false, comment: '사업장' }));
    edit(m => addFk(m, probe, { name: 'fk_mst_erd_probe_mst_brand', columns: ['brand_seq'], refTable: 'mst_brand', refColumns: ['brand_seq'] }));

    // Flyway: 왼쪽 dev, 오른쪽 지금 ERD
    await applyToDb();
    out.compare = compare.value!.items().map(i => `${i.kind} ${i.change} ${i.table ?? ''}.${i.name}`);
    out.beNextVersion = await window.erd.export.nextVersion(`${beDir}/src/main/resource/db/migration`);
    compare.value!.setFlyway({ menuCode: 'menu01' });
    const f1 = await compare.value!.writeFlyway(`${exportDir}/migration`, `${exportDir}/99-migration-history.md`);
    const f2 = await compare.value!.writeFlyway(`${exportDir}/migration`); // 같은 폴더에 다시: 번호가 올라간다
    out.flyway = { first: f1 && { fileName: f1.fileName, history: !!f1.history, statements: f1.statements }, second: f2?.fileName };
    await nextTick(); await frames(5);

    // MD: 스키마 문서, 다시 쓰면 같은 이름을 덮어쓴다, 메뉴 물리 테이블 목록
    openExport();
    await nextTick(); await frames(5);
    const md = await exporter.value!.writeSchema(`${exportDir}/md`);
    const again = await exporter.value!.writeSchema(`${exportDir}/md`);
    const menu = await exporter.value!.writeMenu(`${exportDir}/md`, 'MENU01', ['mst_brand', probe]);
    out.md = { files: md.map(p => p.split(/[\\/]/).pop()), againWritten: again.length, menu: menu.map(p => p.split(/[\\/]/).pop()),
      error: document.querySelector('.export .warn')?.textContent ?? '' };

    while (canUndo.value) undo();
    out.undone = model.value!.tables.every(t => t.name !== probe);
    return JSON.parse(JSON.stringify(out));
  }

  /**
   * STEP 8 시험 (완료 기준): 내장 터미널에서 실제 Claude Code 에 「mst_brand_wh 에 sort_no 컬럼 추가하고 mst_brand_center 옆에 둬」 라고 하면
   * ERD 에 강조된 변경이 나타나고 다른 테이블 위치는 바뀌지 않는다. 모델 파일은 저장하지 않는다(메인이 캡처 뒤 취소한다).
   * prompt 를 주면 그 문장으로, measure 면 토큰 측정용 짧은 요청 두 개(도구 부름, 안 부름)를 json 출력으로 돌린다.
   */
  async function step8Scenario(beDir: string, dir: string, exportDir: string, measure: boolean) {
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    await openModel(dir);
    activeTab.value = 'erd';
    await nextTick(); await frames(10); await sleep(800);
    const out: Record<string, unknown> = {};
    const before = canvas.value!.boxes();
    const info = await window.erd.mcp.info();
    out.mcp = info ? { url: info.url } : null;
    if (!info) return out;

    const tid = await addTerm('powershell');
    await nextTick(); await sleep(3000);
    const term = terminals.value!.get(tid)!;
    /** 터미널에 명령을 치고 끝 표시가 나올 때까지 기다린다. 입력 줄에는 끝 표시 글자가 그대로 나오지 않게 둘로 나눠 친다 */
    const run = async (cmd: string, limitMs: number) => {
      const mark = `ERD_DONE_${Math.random().toString(36).slice(2, 8)}`;
      term.write(`${cmd}; echo ("${mark.slice(0, 5)}" + "${mark.slice(5)}")\r`);
      const t0 = Date.now();
      while (Date.now() - t0 < limitMs) {
        await sleep(1000);
        if (term.bufferText().split('\n').some(l => l.trim() === mark)) return Math.round((Date.now() - t0) / 1000);
      }
      return -1;
    };
    const claude = (prompt: string, extra = '') =>
      `claude -p "${prompt}" --mcp-config "${info.claudeConfig}" --strict-mcp-config --allowedTools "mcp__erd__*" ${extra}`;

    // 토큰 측정: erd_overview 를 부를 때와 안 부를 때 입력 토큰 차이 (대략값)
    if (measure) {
      const a = `${exportDir}/with-overview.json`.replace(/\\/g, '/'), b = `${exportDir}/without.json`.replace(/\\/g, '/');
      out.measure = {
        withOverview: await run(claude('erd_overview 도구를 한 번 부르고, 그 결과의 줄 수만 숫자로 답해', `--output-format json | Out-File -Encoding utf8 "${a}"`), 180_000),
        without: await run(claude('도구를 부르지 말고 0 이라고만 답해', `--output-format json | Out-File -Encoding utf8 "${b}"`), 180_000),
        overviewChars: overview(model.value!).length,
      };
      return JSON.parse(JSON.stringify(out)); // 측정만 한다 (완료 기준 문장은 다시 돌리지 않는다)
    }

    const prompt = 'mst_brand_wh 에 sort_no 컬럼 추가하고 mst_brand_center 옆에 둬';
    out.claudeSeconds = await run(claude(prompt), 300_000);
    await nextTick(); await frames(10); await sleep(1000);
    const m = model.value!;
    const wh = m.tables.find(t => t.name === 'mst_brand_wh')!;
    const center = m.tables.find(t => t.name === 'mst_brand_center')!;
    const after = canvas.value!.boxes();
    const moved = [...before].filter(([id, b]) => id !== wh.id && (after.get(id)?.x !== b.x || after.get(id)?.y !== b.y)).map(([id]) => nameOf(id));
    const c = after.get(center.id)!, w = after.get(wh.id)!;
    out.result = {
      sortNo: wh.columns.find(x => x.name === 'sort_no') ?? null,
      pinned: diagram.value!.pinned[wh.id] ?? null,
      whBox: w, centerBox: c,
      besideCenter: w.x >= c.x + c.w && w.x - (c.x + c.w) < 400 && Math.abs(w.y - c.y) < 600,
      otherTablesMoved: moved.length, movedNames: moved.slice(0, 10), totalTables: before.size,
      highlighted: [...aiChanged.value].map(nameOf), highlightDom: document.querySelectorAll('.vue-flow__node-table .tbl.ai').length,
      banner: document.querySelector('.ai-bar')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      saveDisabled: (document.querySelector('header button:nth-of-type(2)') as HTMLButtonElement | null)?.disabled ?? null,
    };
    out.terminalTail = term.bufferText().split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-12);
    await canvas.value!.focusTable('mst_brand_wh');
    return JSON.parse(JSON.stringify(out));
  }
  /** STEP 8 시험 끝: 확정 대기를 취소해 원래 모델로 (저장하지 않음) */
  window.__erdAiCancel = () => { aiCancel(); return { pending: !!aiBase.value, tables: model.value?.tables.length, sortNo: !!model.value?.tables.find(t => t.name === 'mst_brand_wh')?.columns.some(c => c.name === 'sort_no') }; };

  /** 자동완성 목록 시험: dev 에 접속한 SQL 탭에서 글자를 쳐 목록을 띄우고, 항목 글자와 글자색, 배경색을 잰다 (화면은 메인이 캡처) */
  async function suggestScenario(beDir: string) {
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    const id = addSql();
    await nextTick(); await frames(5);
    const tab = tabRefs.get(id) as InstanceType<typeof SqlTab>;
    await tab.loadOptions();
    await tab.connect('be:dev');
    await sleep(2000); // 접속한 DB 목록 읽기
    const ed = tab.editor()!;
    ed.setValue('');
    ed.focus();
    for (const ch of 'select * from mst_b') ed.trigger('keyboard', 'type', { text: ch });
    await sleep(1200);
    const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')).slice(0, 5);
    const style = (el: Element | null) => { if (!el) return null; const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor, font: s.fontFamily.slice(0, 60), size: s.fontSize, opacity: s.opacity }; };
    const widget = document.querySelector('.suggest-widget');
    return {
      catalogTables: tab.catalogSize(),
      rows: rows.map(r => ({ aria: r.getAttribute('aria-label'), text: r.textContent?.trim().slice(0, 80), label: style(r.querySelector('.label-name') ?? r) })),
      widget: style(widget), row0: style(rows[0] ?? null),
      labelNameStyle: style(document.querySelector('.suggest-widget .monaco-list-row .label-name')),
      highlight: style(document.querySelector('.suggest-widget .monaco-list-row .monaco-highlighted-label')),
    };
  }

  /**
   * 비밀번호 창 시험: beDir 은 비밀번호를 자동으로 풀 수 없는 시험용 BE 폴더다.
   * 접속 시험 → 「자동으로 풀지 못했다」 창 → 틀린 비밀번호 → DB 거부 → 「틀렸다」 창 → 취소 → 접속 시험 결과에 취소가 나온다.
   */
  async function passwordScenario(beDir: string) {
    await panel.value!.setSource('be');
    await panel.value!.setBeDir(beDir);
    const waitAsk = async () => { for (let i = 0; i < 100 && !pwAsk.value; i++) await sleep(100); return pwAsk.value ? { ...pwAsk.value } : null; };
    const out: Record<string, unknown> = {};
    const result = window.erd.conn.test({ source: 'be', beDir, name: 'dev' });
    const first = await waitAsk();
    out.first = first && { label: first.label, reason: first.reason, dialog: !!document.querySelector('.modal input[type=password]') };
    pwInput.value = { password: 'erd-tool-wrong-password', save: false };
    answerPw(true);
    await sleep(300);
    const second = await waitAsk();
    out.second = second && { reason: second.reason };
    answerPw(false);
    out.result = await result;
    out.dialogClosed = !pwAsk.value;
    return JSON.parse(JSON.stringify(out));
  }

  /** STEP 9: 다른 DBMS 를 직접 입력 접속으로 붙여 접속 시험 → 리버스 → 저장 → 캔버스 → SQL 탭 조회. 접속은 끝에 지운다 */
  async function dbmsScenario(baseDir: string, list: { name: string; conn: ManualConn; password: string; sql: string }[]) {
    const out: Record<string, unknown> = {};
    for (const d of list) {
      const saved = await window.erd.manual.save({ ...d.conn, id: '', name: d.name, savePassword: false }, d.password);
      const ref: ConnRef = { source: 'manual', id: saved.id };
      try {
        const test = await window.erd.conn.test(ref);
        const dir = `${baseDir}/${d.conn.driver}`;
        await setModelDir(dir);
        const r = await window.erd.db.reverse(ref, dir);
        applyReverse(r);
        await saveTo(dir);
        await openModel(dir);
        await nextTick(); await frames(10); await sleep(800);
        const id = addSql();
        await nextTick(); await frames(5);
        const tab = tabRefs.get(id) as InstanceType<typeof SqlTab>;
        await tab.loadOptions();
        await tab.connect('manual:' + saved.id);
        tab.editor()!.setValue(d.sql);
        await tab.run();
        await frames(5); await sleep(300);
        out[d.conn.driver] = {
          test: { ok: test.ok, tables: test.tables, fks: test.fks, server: test.server },
          reverse: { tables: r.model.tables.length, fks: r.model.tables.reduce((n, t) => n + t.fks.length, 0), counts: r.counts, dialect: r.model.dialect, schema: r.model.schema, warnings: r.warnings.length },
          loaded: { tables: model.value?.tables.length, dialect: model.value?.dialect, nodes: document.querySelectorAll('.vue-flow__node').length },
          sql: { grid: tab.grid(), state: tab.state() },
        };
      } catch (e) {
        out[d.conn.driver] = { error: (e as Error).message };
      } finally {
        await window.erd.manual.remove(saved.id);
      }
    }
    return JSON.parse(JSON.stringify(out));
  }

  /** STEP 10 시험: 모델만 연다. 키보드, 마우스 입력은 메인이 실제 입력으로 보내고 __erdProbe 로 화면 상태를 읽는다 */

  /**
   * AI 대상 탭 (4-4, 2026-10-22 재현): ERD 탭 A 에서 AI 가 읽은 뒤 사람이 탭 B 로 옮겨도 AI 변경은 A 에 들어가야 한다.
   * B 는 A 모델을 exportDir 에 저장해 만든 복사본이다. 끝에 취소해 원래대로 둔다 (파일에 저장하지 않음)
   */
  async function aiTabScenario(beDir: string, dir: string, exportDir: string) {
    await panel.value!.setSource('be'); await panel.value!.setBeDir(beDir);
    await openModel(dir);
    const bDir = `${exportDir}/model-b`;
    await saveTo(bDir);
    const b = addErd();
    await nextTick();
    await openModel(bDir);
    const a = [...docs.keys()].find(id => id !== b)!;
    const has = (id: string) => !!docs.get(id)!.model.value?.tables.some(t => t.name === 'zz_ai_probe');
    activeTab.value = a; await nextTick(); await frames(5);
    const read = (await runTool('erd_overview', {})).split('\n')[0];
    activeTab.value = b; await nextTick(); await frames(5); // 사람이 다른 탭으로 옮긴다
    await runTool('erd_apply', { commands: ['add_table zz_ai_probe #AI 대상 탭 시험'] });
    const applied = { inA: has(a), inB: has(b), shown: activeTab.value === a ? 'A' : 'B', aiTab: aiTab.value === a ? 'A' : aiTab.value, title: titleOf(a) };
    aiCancel();
    return { read, applied, afterCancel: { inA: has(a), aiTab: aiTab.value } };
  }

  return { sqlScenario, step5Scenario, step6Scenario, step7Scenario, step8Scenario, suggestScenario, passwordScenario, dbmsScenario, aiTabScenario };
}
