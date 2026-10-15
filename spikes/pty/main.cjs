// STEP 1 시험: Electron 메인에서 node-pty 로 pwsh.exe 를 띄우고 렌더러의 xterm.js 와 IPC 로 잇는다.
// --auto 면 claude --version, echo 가나다 를 입력하고 렌더러가 읽은 화면 내용을 result.txt 에 쓰고 종료한다.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const pty = require('node-pty');

const AUTO = process.argv.includes('--auto');
const HUB = 'C:/work/workspace/docs-hub';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1100, height: 700,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  // PATH 에 pwsh 가 없는 실행 환경이 있어(Git Bash 에서 띄운 경우) 설치 경로를 직접 쓴다
  const shell = pty.spawn('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: HUB, env: process.env });
  shell.onData(d => win.webContents.send('pty:data', d));
  ipcMain.on('pty:input', (_e, d) => shell.write(d));
  ipcMain.on('pty:resize', (_e, { cols, rows }) => shell.resize(cols, rows));
  win.loadFile('index.html');

  if (AUTO) {
    setTimeout(() => shell.write('claude --version\r'), 4000);
    setTimeout(() => shell.write('echo 가나다ABC\r'), 9000);
    setTimeout(() => win.webContents.send('pty:report'), 12000);
    ipcMain.on('pty:report', (_e, text) => {
      fs.writeFileSync(path.join(__dirname, 'result.txt'), `electron ${process.versions.electron} node-pty ok pid=${shell.pid}\n${text}`);
      shell.kill(); app.quit();
    });
  }
});
