// 렌더러에 셸 입출력 함수만 연다 (셸 실행은 메인만 한다)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pty', {
  onData: cb => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  input: d => ipcRenderer.send('pty:input', d),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  onReportRequest: cb => ipcRenderer.on('pty:report', () => cb()),
  report: text => ipcRenderer.send('pty:report', text),
});
