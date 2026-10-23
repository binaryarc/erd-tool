// 렌더러에 ErdApi 함수만 연다. ipcRenderer 자체는 열지 않는다 (Electron 보안 권고)
// 함수 목록과 채널 이름은 shared/ipc.ts 의 API 표 하나에서 정한다. 여기서는 그 표대로 연결만 만든다.
import { contextBridge, ipcRenderer } from 'electron';
import { API, type ApiDef, type ErdApi } from '../shared/ipc';

type Def = ApiDef<'invoke' | 'send' | 'on', (...args: never[]) => unknown>;

const connect = (def: Def): unknown => {
  const { kind, channel } = def;
  if (kind === 'invoke') return (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
  if (kind === 'send') return (...args: unknown[]) => ipcRenderer.send(channel, ...args);
  return (cb: (...args: unknown[]) => void) => { ipcRenderer.on(channel, (_e, ...args) => cb(...args)); };
};

const build = (node: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(node).map(([name, v]) => [name, 'channel' in v ? connect(v as Def) : build(v)]));

contextBridge.exposeInMainWorld('erd', build(API) as unknown as ErdApi);
