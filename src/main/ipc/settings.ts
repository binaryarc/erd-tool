import { ipcMain } from 'electron';
import { API } from '../../shared/ipc';
import { getSession, getSettings, setSession, setSettings } from '../settings';

export function registerSettingsIpc() {
  ipcMain.handle(API.settings.get.channel, () => getSettings());
  ipcMain.handle(API.settings.set.channel, (_e, patch) => setSettings(patch));
  ipcMain.handle(API.session.get.channel, () => getSession());
  ipcMain.handle(API.session.set.channel, (_e, data) => setSession(data));
}
