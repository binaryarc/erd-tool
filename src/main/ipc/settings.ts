import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc';
import { getSession, getSettings, setSession, setSettings } from '../settings';

export function registerSettingsIpc() {
  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch) => setSettings(patch));
  ipcMain.handle(IPC.sessionGet, () => getSession());
  ipcMain.handle(IPC.sessionSet, (_e, data) => setSession(data));
}
