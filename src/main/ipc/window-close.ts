import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc';
import { dirtyTabs } from '../db/session';

export function registerWindowCloseIpc(win: BrowserWindow) {
  // 창 닫기: 커밋 안 한 탭이나 저장 안 한 ERD 변경이 있으면 화면에 묻는다 (설계 5장 6번)
  // 시험 모드(ERD_AUTO)는 끝에 app.quit() 으로 닫으므로 묻지 않는다 (물으면 시험이 멈춘다)
  // 마지막 화면 시험(ERD_SESSION)은 X 버튼과 같은 길로 닫아 본다
  let closing = !!process.env.ERD_AUTO && !process.env.ERD_SESSION;
  let modelDirty = false;
  ipcMain.on(IPC.modelDirty, (_e, d: boolean) => { modelDirty = d; });
  // X 버튼이 아닌 길(화면 안의 window.close(), 새로 고침 Ctrl+R)은 'close' 이벤트를 거치지 않는다.
  // 화면의 beforeunload 가 막으면 여기로 오고, 메인이 창으로 묻는다 (2026-10-16: window.close() 로 묻지 않고 닫혔다)
  win.webContents.on('will-prevent-unload', e => {
    if (closing) { e.preventDefault(); return; } // 이미 X 버튼 확인을 거쳤다
    const sql = dirtyTabs().map(d => d.label);
    const what = [modelDirty ? '저장하지 않은 ERD 변경' : '', sql.length ? `커밋하지 않은 SQL 탭(${sql.join(', ')}, 롤백됩니다)` : ''].filter(Boolean).join(', ');
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['나가기', '머무르기'], defaultId: 1, cancelId: 1, title: 'ERD 도구',
      message: `${what || '저장하지 않은 변경'}이 있습니다. 화면을 닫거나 새로 고치면 사라집니다. 계속할까요?`,
    });
    if (choice === 0) e.preventDefault();
  });
  // 창을 닫을 때는 항상 화면에 먼저 알린다. 화면이 마지막 화면(session.json)을 쓰고, 커밋 안 한 SQL 탭이 있으면 묻는다 (STEP 10).
  // 저장 안 한 ERD 변경은 마지막 화면에 담겨 다시 켜면 돌아오므로 묻지 않는다.
  // 화면이 답하지 않으면(멈춤) 3초 뒤 다시 누른 X 는 그냥 닫는다
  let askedAt = 0;
  win.on('close', e => {
    if (closing) return;
    if (askedAt && Date.now() - askedAt > 3000) return;
    e.preventDefault();
    askedAt = Date.now();
    win.webContents.send(IPC.closeRequest, dirtyTabs(), modelDirty);
  });
  ipcMain.on(IPC.closeConfirm, (_e, ok: boolean) => {
    askedAt = 0;
    if (!ok) return;
    closing = true;
    win.close();
  });
}
