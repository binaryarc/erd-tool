// STEP 10 시험 모드 입력: 실제 키보드, 마우스 입력(sendInputEvent)으로 편집 편의 기능을 눌러 보고 화면 상태를 모은다.
// 화면 쪽 준비(모델 열기)는 renderer 의 __erdAuto({ scenario: 'step10' }), 상태 읽기는 __erdProbe 가 한다.
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
