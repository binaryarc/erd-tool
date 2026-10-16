// STEP 10 시험 모드 입력: 실제 키보드, 마우스 입력(sendInputEvent)으로 편집 편의 기능을 눌러 보고 화면 상태를 모은다.
// 화면 쪽 준비(모델 열기)는 renderer 의 __erdAuto({ scenario: 'step10' }), 상태 읽기는 __erdProbe 가 한다.
import fs from 'node:fs';
import type { BrowserWindow } from 'electron';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function step10Inputs(win: BrowserWindow, part: string): Promise<Record<string, unknown>> {
  const wc = win.webContents;
  const js = <T = unknown>(s: string) => wc.executeJavaScript(s) as Promise<T>;
  const probe = (table?: string) => js(`window.__erdProbe(${JSON.stringify(table ?? null)})`);
  wc.focus();
  const key = async (keyCode: string, modifiers: ('control' | 'shift')[] = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(300);
  };
  const click = async (x: number, y: number, modifiers: ('control' | 'shift')[] = [], button: 'left' | 'right' = 'left', clickCount = 1) => {
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button, clickCount, modifiers });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button, clickCount, modifiers });
    await sleep(300);
  };
  /** selector 에 맞는 요소 중 글자가 text 인 것(없으면 첫 요소)의 가운데 */
  const centerOf = (selector: string, text?: string) => js<{ x: number; y: number } | null>(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${JSON.stringify(text ?? null)} === null || e.textContent.trim() === ${JSON.stringify(text ?? null)});
    if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  const clickText = async (selector: string, text?: string, button: 'left' | 'right' = 'left', clickCount = 1) => {
    const p = await centerOf(selector, text);
    if (!p) throw new Error(`누를 곳이 없다: ${selector} ${text ?? ''}`);
    if (clickCount === 2) { await click(p.x, p.y, [], button, 1); wc.sendInputEvent({ type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button, clickCount: 2 }); wc.sendInputEvent({ type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button, clickCount: 2 }); await sleep(300); }
    else await click(p.x, p.y, [], button, clickCount);
  };
  const typeText = async (text: string) => { for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(300); };
  const drag = async (from: { x: number; y: number }, dx: number, dy: number) => {
    const ev = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number) =>
      wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    ev('mouseDown', from.x, from.y);
    for (let i = 1; i <= 8; i++) { ev('mouseMove', from.x + (dx * i) / 8, from.y + (dy * i) / 8); await sleep(30); }
    ev('mouseUp', from.x + dx, from.y + dy);
    await sleep(400);
  };
  const nodeAt = (name: string) => js<{ x: number; y: number } | null>(`window.__erdNodeRect(${JSON.stringify(name)})`);
  const out: Record<string, unknown> = {};

  if (part === 'enter') {
    // 완료 기준: 테이블을 고르고 Enter 세 번 → 컬럼 3개(NULL 허용), Ctrl+Z 세 번 → 원래 모델
    const table = 'mst_biz_wh';
    const p = await nodeAt(table);
    if (!p) throw new Error(`${table} 노드를 못 찾았다`);
    out.before = await probe(table);
    await click(p.x, p.y);
    out.afterClick = await probe(table);
    for (let i = 0; i < 3; i++) await key('Enter');
    await sleep(300);
    out.afterEnter = await probe(table);
    // 이름 칸에 글자를 치고 Enter: 이름이 바뀌고 그 뒤에 다음 컬럼
    for (const ch of 'memo_txt') wc.sendInputEvent({ type: 'char', keyCode: ch });
    await sleep(200);
    await key('Enter');
    out.afterRenameEnter = await probe(table);
    // 마지막 두 수정(이름 바꾸기, 추가)은 먼저 되돌린다. 나머지 세 번이 완료 기준
    for (let i = 0; i < 2; i++) await key('Z', ['control']);
    out.afterTwoUndo = await probe(table);
    for (let i = 0; i < 3; i++) await key('Z', ['control']);
    out.afterUndo = await probe(table);
    // 새 테이블 직후 Enter: 캔버스에 mst_biz_wh 가 골라져 있어도 새 테이블에 첫 컬럼이 생긴다
    await clickText('header button', '새 테이블');
    await sleep(800);
    await js(`document.activeElement && document.activeElement.blur()`); // 버튼 위 Enter 는 버튼 누르기라 포커스를 뺀다
    await key('Enter');
    out.newTable = await probe('new_table');
    for (let i = 0; i < 2; i++) await key('Z', ['control']);
    out.newTableUndone = await probe('new_table');
  }

  if (part === 'session1') {
    // 마지막 화면 1회차: ERD 탭 1(model-g)에 Enter 로 컬럼 하나, 그룹 탭 만들어 보기. ERD 탭 2(model-h)는 저장된 상태로 열고 화면 이동.
    // SQL 탭에 글자를 넣고 dev 에 접속. 보던 탭은 ERD 탭 1. 끝나면 메인이 그대로 닫는다(X 버튼과 같은 길로 마지막 화면을 쓴다)
    const s = (step: string, arg?: string) => js(`window.__erdSession(${JSON.stringify(step)}, ${JSON.stringify(arg ?? null)})`);
    const p = await nodeAt('mst_biz_wh');
    await click(p!.x, p!.y);
    await key('Enter');
    await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await clickText('.dtabs button', '+');
    await sleep(600);
    await s('addErd');
    await s('open', process.env.ERD_MODEL_DIR2!);
    await s('pan', 'mst_wh');
    await s('addSql', 'select 1 as session_probe');
    await s('activate', 'erd');
    out.before = await s('flush');
    // 저장(flush) 뒤에 SQL 탭으로 옮긴다. 다시 켰을 때 SQL 탭이 보이면 창 닫기 때 한 번 더 쓴 것이다
    await s('activate', 'sql-1');
  }
  if (part === 'session2') {
    // 다시 켠 뒤 ERD 탭 2 로 가면 저장해 둔 화면 위치로 열리고, ERD 탭 1 로 돌아오면 떠날 때 위치다
    const s = (step: string, arg?: string) => js(`window.__erdSession(${JSON.stringify(step)}, ${JSON.stringify(arg ?? null)})`);
    out.erd2 = await s('activate', 'erd-2');
    out.erd1 = await s('activate', 'erd');
  }
  if (part === 'connect') try {
    // 완료 기준: 화면에서 선을 끌어 만든 FK 를 dev 에 적용하고 다시 읽으면 차이 0. 자식에 컬럼이 없던 경우도 같다
    const c = (step: string, a?: string, b?: string) => js<Record<string, unknown> | { x: number; y: number } | null>(`window.__erdConnect(${JSON.stringify(step)}, ${JSON.stringify(a ?? null)}, ${JSON.stringify(b ?? null)})`);
    const pt = async (step: string, a: string, b?: string) => { const p = await c(step, a, b) as { x: number; y: number } | null; if (!p) throw new Error(`위치를 못 찾았다: ${step} ${a} ${b ?? ''}`); return p; };
    const dragTo = async (from: { x: number; y: number }, to: { x: number; y: number }) => drag(from, to.x - from.x, to.y - from.y);
    out.prep = await c('prep', process.env.ERD_BE_DIR!);
    // 1. 자식에 컬럼이 없는 경우: mst_biz 의 biz_seq 연결점에서 끌어 시험 테이블 몸통(연결점이 아닌 곳)에 놓는다 → 새 컬럼 biz_seq
    await dragTo(await pt('handle', 'mst_biz', 's-biz_seq'), await pt('body', 'mst_erd_probe'));
    out.askNew = await c('state');
    await clickText('.dialog.conn button', '만들기');
    out.afterNew = await c('state');
    // 2. 자식에 컬럼이 있는 경우, 자식 쪽에서 부모 쪽으로: 시험 테이블 wh_seq 연결점 → mst_wh 의 wh_seq 연결점. ON DELETE CASCADE
    await dragTo(await pt('handle', 'mst_erd_probe', 't-wh_seq'), await pt('handle', 'mst_wh', 't-wh_seq'));
    out.askExisting = await c('state');
    await c('answer', 'onDelete', 'cascade');
    await clickText('.dialog.conn button', '만들기');
    out.afterExisting = await c('state');
    // 3. 복합 PK 테이블 머리에서 PK 없는 테이블로 끌면 오류로 안내하고 자식 쪽 편집 패널을 연다
    await dragTo(await pt('handle', 'mst_erd_probe_cpk', 's-*'), await pt('body', 'mst_erd_probe_nopk'));
    out.composite = await c('state');
    await clickText('.editor header button', '×'); // 안내로 열린 편집 패널을 닫는다 (오른쪽 테이블을 가린다)
    await sleep(1000); // 캔버스 폭이 돌아온 뒤 선 위치를 읽는다
    // 4. 선을 눌러 고르고 Delete → FK 삭제, Ctrl+Z 로 되살림
    const fk = ((out.afterExisting as { fks: { name: string }[] }).fks.at(-1))!.name;
    const e = await pt('edge', 'mst_erd_probe', fk);
    await click(e.x, e.y);
    out.edgeSelected = await c('state');
    await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await key('Delete');
    out.edgeDeleted = await c('state');
    await key('Z', ['control']);
    out.edgeRestored = await c('state');
    // 5. dev 에 적용(커밋) → 다시 읽어 차이 0. 끝에 되돌리기로 처음 모델로 돌아가 같은 길로 시험 테이블을 지운다
    out.apply = await c('apply', process.env.ERD_BE_DIR!);
  } catch (e) {
    out.error = (e as Error).message;
    if (process.env.ERD_SHOT) fs.writeFileSync(`${process.env.ERD_SHOT}-fail.png`, (await wc.capturePage()).toPNG()); // 멈춘 화면
  } finally {
    if (part === 'connect' && out.prep) out.cleanup = await js(`window.__erdConnect('cleanup', ${JSON.stringify(process.env.ERD_BE_DIR)})`);
  }
  if (part === 'savepreview') try {
    // 예전 형식(접두어 그룹 파일 나눔, 트리인데 layout.json 에 그룹 격자 항목) 모델 폴더를 열고 같은 폴더에 저장:
    // 미리보기 창에 새로 씀(tables.erd), 바뀜(_index.erd, layout.json), 지움(mdm.erd 등)이 나오고, 「저장」 을 누르면 그대로 된다
    const dir = process.env.ERD_SAVE_DIR!;
    const readDir = () => fs.readdirSync(dir).sort();
    out.before = { files: readDir(), layoutGroups: Object.keys(JSON.parse(fs.readFileSync(`${dir}/layout.json`, 'utf8')).diagrams?.['전체']?.groups ?? {}) };
    out.opened = await js(`window.__erdSavePreview(${JSON.stringify(dir)})`);
    out.preview = await js(`[...document.querySelectorAll('.save-preview .sp-group')].map(g => ({ kind: g.dataset.kind, files: [...g.querySelectorAll('li')].map(li => li.textContent) }))`);
    out.filesBeforeClick = readDir(); // 미리보기만으로는 아무것도 쓰지 않는다
    await clickText('.save-preview .row button', '저장');
    await sleep(1500);
    const layout = JSON.parse(fs.readFileSync(`${dir}/layout.json`, 'utf8'));
    out.after = { files: readDir(), layoutGroups: layout.diagrams?.['전체']?.groups ?? null, message: await js(`document.querySelector('footer span')?.textContent`) };
    // 그룹 격자로 바꾸면 그때 그룹 격자 항목을 만들어 그룹 상자가 그려진다
    out.grid = await js(`window.__erdView({ mode: 'grid' }).then(v => ({ ...v, groupBoxes: [...document.querySelectorAll('.vue-flow__node-group .group-box span')].map(e => e.textContent) }))`);
  } catch (e) { out.error = (e as Error).message; }
  if (part === 'domain') try {
    // 완료 기준: 도메인 타입을 바꾸면 쓰는 모든 컬럼이 바뀌고 dev 에 적용한 뒤 다시 읽으면 차이 0. 저장 → 읽기 → 저장 바이트 같음.
    // 같은 모델 폴더로 DB 에서 다시 불러와도 연결이 남고, 타입이 바뀐 컬럼만 풀리며 경고가 나온다. 끝에 dev 의 시험 테이블을 지운다
    const be = process.env.ERD_BE_DIR!, dir = process.env.ERD_SAVE_DIR!;
    const d = (step: string, a?: string, b?: string) => js<Record<string, unknown>>(`window.__erdDomain(${JSON.stringify(step)}, ${JSON.stringify(a ?? null)}, ${JSON.stringify(b ?? null)})`);
    const typeInto = async (selector: string, text: string) => {
      await clickText(selector);
      await key('A', ['control']);
      await typeText(text);
    };
    out.prep = await d('prep', be, dir);
    // 1. 도메인 패널에서 도메인 probe_cd (varchar(10)) 를 만든다 (실제 클릭, 글자 입력)
    await clickText('header button', '도메인');
    await typeInto('.domains tr.new td:nth-child(2) input', 'probe_cd');
    await typeInto('.domains tr.new td:nth-child(3) input', 'varchar(10)');
    await key('Enter');
    out.made = await d('state');
    // 2. 편집 패널에서 a_cd, b_cd 의 도메인 칸에서 probe_cd 를 고른다 (select 는 값을 바꾸고 change 를 보낸다)
    await d('editor', 'mst_erd_probe');
    for (const c of ['a_cd', 'b_cd']) await js(`(() => { const s = document.querySelector('select[data-domain-col="${c}"]'); s.value = 'probe_cd'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    out.linked = await d('state');
    // 3. a_cd 타입 칸을 varchar(20) 으로 고친다 → 도메인과 b_cd 도 함께 바뀐다
    const typeCell = `.editor tbody tr:nth-child(2) input.type`;
    await typeInto(typeCell, 'varchar(20)');
    await key('Enter'); // 칸을 벗어나지 않으니 바깥을 눌러 change 를 낸다
    await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await sleep(300);
    out.typeChanged = await d('state');
    out.apply = await d('apply', be);
    // 4. 저장 → 다시 저장(바뀐 파일 0) → 다시 열기
    out.save = await d('saveTwice', be, dir);
    // 5. 도구 밖에서 dev 의 b_cd 타입을 바꾸고, 같은 모델 폴더로 DB 에서 다시 불러온다
    out.sql = await d('sql', be, 'alter table mst_erd_probe alter column b_cd type varchar(25)');
    out.reverse = await d('reverse', be, dir);
    out.afterReverse = await d('state');
  } catch (e) {
    out.error = (e as Error).message;
    if (process.env.ERD_SHOT) fs.writeFileSync(`${process.env.ERD_SHOT}-fail.png`, (await wc.capturePage()).toPNG());
  } finally {
    if (part === 'domain' && out.prep) out.cleanup = await js(`window.__erdDomain('cleanup', ${JSON.stringify(process.env.ERD_BE_DIR)})`);
  }
  if (part === 'undo') try {
    // 테이블 이동(여러 개 함께 포함), 자동 정렬, 정렬 방식, 그룹 탭, 선 연결 FK 를 각각 Ctrl+Z 로 되돌리고 Ctrl+Y 로 다시 한다
    const u = (step: string, a?: string, b?: string) => js<Record<string, unknown> | null>(`window.__erdUndo(${JSON.stringify(step)}, ${JSON.stringify(a ?? null)}, ${JSON.stringify(b ?? null)})`);
    const head = async (name: string) => { const p = await js<{ x: number; y: number } | null>(`(() => { const t = [...document.querySelectorAll('.pane.canvas .split > .pane:first-child .vue-flow__node-table')].find(e => e.querySelector('.head b')?.textContent === ${JSON.stringify(name)}); const r = t?.querySelector('.head')?.getBoundingClientRect(); return r ? { x: r.x + 30, y: r.y + r.height / 2 } : null; })()`); if (!p) throw new Error(`${name} 머리를 못 찾았다`); return p; };
    const blur = () => js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await u('fit', 'mst_biz,mst_wh');
    // 1. 한 테이블 끌기 → 되돌리기 → 다시 하기
    await drag(await head('mst_biz'), 150, 80);
    out.moved = await u('state', 'mst_biz');
    await blur(); await key('Z', ['control']);
    out.moveUndone = await u('state', 'mst_biz');
    await key('Y', ['control']);
    out.moveRedone = await u('state', 'mst_biz');
    // 2. 두 테이블을 골라 함께 끌기 → 되돌리기 한 번으로 둘 다 돌아온다
    await u('fit', 'mst_biz,mst_wh');
    const pb = await head('mst_biz'), pw = await head('mst_wh');
    await click(pb.x, pb.y);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Control' }); // Vue Flow 는 Ctrl 키 눌림을 따로 본다
    await click(pw.x, pw.y, ['control']);
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
    await sleep(200);
    await drag(await head('mst_wh'), -60, 120);
    out.multiMoved = await u('state', 'mst_biz', 'mst_wh');
    await blur(); await key('Z', ['control']);
    out.multiUndone = await u('state', 'mst_biz', 'mst_wh');
    // 3. 자동 정렬 → 되돌리기
    await clickText('header button', '자동 정렬');
    out.arranged = await u('state');
    await blur(); await key('Z', ['control']);
    out.arrangeUndone = await u('state');
    // 4. 정렬 방식 바꾸기 → 되돌리기
    await js(`(() => { const s = [...document.querySelectorAll('header select')].find(e => [...e.options].some(o => o.value === 'grid')); s.value = 'grid'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(500);
    out.modeChanged = await u('state');
    await blur(); await key('Z', ['control']);
    out.modeUndone = await u('state');
    // 5. 그룹 탭 만들기 → 되돌리기 → 다시 하기
    await clickText('.dtabs button', '+');
    await sleep(500);
    out.tabMade = await u('state');
    await blur(); await key('Z', ['control']);
    out.tabUndone = await u('state');
    await key('Y', ['control']);
    out.tabRedone = await u('state');
    await key('Z', ['control']);
    // 6. 선 연결로 만든 FK(새 컬럼 포함) → 되돌리기 한 번에 FK 와 새 컬럼이 함께 없어진다
    await clickText('header button', '새 테이블');
    await sleep(600);
    await blur();
    await u('place', 'new_table', 'mst_biz');
    const from = await js<{ x: number; y: number }>(`(() => { const t = [...document.querySelectorAll('.pane.canvas .split > .pane:first-child .vue-flow__node-table')].find(e => e.querySelector('.head b')?.textContent === 'mst_biz'); const r = t.querySelector('.vue-flow__handle[data-handleid="s-biz_seq"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const to = await head('new_table');
    await drag(from, to.x + 20 - from.x, to.y + 30 - from.y);
    out.connectAsk = await u('state', 'new_table');
    await clickText('.dialog.conn button', '만들기');
    out.connected = await u('state', 'new_table');
    await blur(); await key('Z', ['control']);
    out.connectUndone = await u('state', 'new_table');
    await key('Z', ['control']);
    out.tableUndone = await u('state', 'new_table');
  } catch (e) { out.error = (e as Error).message; }
  if (part === 'groups') try {
    const dir = process.env.ERD_SAVE_DIR!;
    // 1. 빈 그룹 탭을 만들고 그 탭의 「테이블 추가」 로 기존 테이블 3개를 한 번에 넣는다 (다른 탭으로 가지 않는다)
    await clickText('.dtabs button', '+');
    out.newTab = await probe();
    await clickText('.dtabs button', '테이블 추가');
    for (const name of ['mst_biz', 'mst_biz_wh', 'mst_biz_center']) {
      await js(`document.querySelector('.pick .q').select()`);
      await typeText(name);
      await clickText('.pick li b', name); // 이름 글자를 누르면 그 줄 체크 칸이 켜진다 (label 안)
    }
    out.picked = await js(`[...document.querySelectorAll('.pick li input:checked')].length`);
    await clickText('.pick .row button', '3개 넣기');
    await sleep(800);
    out.afterPick = await probe();
    // 2. mst_biz_wh 를 우클릭 → 새 그룹 만들어 추가. 두 그룹에서 각각 다른 자리로 끈다
    let p = await nodeAt('mst_biz_wh');
    await click(p!.x, p!.y, [], 'right');
    out.menu = await probe();
    await clickText('.ctx button', '새 그룹 만들어 추가');
    p = await nodeAt('mst_biz_wh');
    await drag(p!, 300, 120);
    await clickText('.dtabs button', '그룹 2');
    await sleep(800);
    p = await nodeAt('mst_biz_wh');
    await drag(p!, -200, 260);
    out.twoGroups = await probe();
    // 3. 그룹 1 에서 새 테이블 → 그 그룹과 전체에 모두 보인다
    await clickText('.dtabs button', '그룹 1');
    await sleep(800);
    await clickText('header button', '새 테이블');
    await sleep(800);
    out.newTableInGroup = await probe();
    await clickText('.dtabs button', '전체');
    await sleep(800);
    out.newTableInAll = { nodes: ((await probe()) as { nodes: string[] }).nodes.filter(n => n.startsWith('new_table')) };
    // 4. 그룹 1 에서 mst_biz_center 를 Delete → 확인 창 → 모델에서 삭제. Ctrl+Z 로 소속까지 돌아온다
    await clickText('.dtabs button', '그룹 1');
    await sleep(800);
    p = await nodeAt('mst_biz_center');
    await click(p!.x, p!.y);
    await js(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await key('Delete');
    out.deleteAsk = ((await probe()) as { dialog: string }).dialog;
    await clickText('.dialog.ask button', '모델에서 삭제');
    out.afterDelete = await probe();
    await key('Z', ['control']);
    await sleep(500);
    out.afterUndo = await probe();
    // 5. 그룹 2 에서 더블클릭하면 다른 그룹(전체 모델 기준) 연결 테이블까지 미니 ERD 에 나온다
    await clickText('.dtabs button', '그룹 2');
    await sleep(800);
    p = await nodeAt('mst_biz_wh');
    await click(p!.x, p!.y, [], 'left', 1);
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(p!.x), y: Math.round(p!.y), button: 'left', clickCount: 2 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(p!.x), y: Math.round(p!.y), button: 'left', clickCount: 2 });
    await sleep(1500);
    out.mini = await probe();
    // 6. 저장하고 다시 열어도 그룹과 위치가 같다
    out.saveReopen = await js(`window.__erdSaveReopen(${JSON.stringify(dir)})`);
  } catch (e) { out.error = (e as Error).message; } // 멈춘 곳까지 모은 상태를 함께 본다
  return out;
}
