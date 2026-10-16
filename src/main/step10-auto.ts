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
    const btn = await js<{ x: number; y: number }>(`(() => { const b = [...document.querySelectorAll('header button')].find(e => e.textContent.trim() === '테이블 추가').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await click(btn.x, btn.y);
    await sleep(800);
    await js(`document.activeElement && document.activeElement.blur()`); // 버튼 위 Enter 는 버튼 누르기라 포커스를 뺀다
    await key('Enter');
    out.newTable = await probe('new_table');
    for (let i = 0; i < 2; i++) await key('Z', ['control']);
    out.newTableUndone = await probe('new_table');
  }
  return out;
}
