// 앱 설정 (BE 폴더, 모델 폴더). 비밀번호는 담지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Settings } from '../shared/ipc';

const file = () => path.join(app.getPath('userData'), 'settings.json');

export function getSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

export function setSettings(patch: Settings): Settings {
  const next = { ...getSettings(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}
