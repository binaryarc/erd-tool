// 앱 설정 (BE 폴더, 모델 폴더). 비밀번호는 담지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { SessionData, Settings } from '../shared/ipc';

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

// ---------- 마지막 화면 (STEP 10 결정 22) ----------
// 시험 모드(ERD_AUTO)는 사람이 쓰는 화면 상태와 섞이지 않게 ERD_SESSION 을 줄 때만 읽고 쓴다
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
const sessionOn = () => !process.env.ERD_AUTO || !!process.env.ERD_SESSION;

export function getSession(): SessionData | null {
  if (!sessionOn()) return null;
  try {
    const d = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) as SessionData;
    return d.version === 1 && Array.isArray(d.tabs) ? d : null;
  } catch {
    return null;
  }
}

/** 임시 파일에 쓰고 바꿔 끼운다 (쓰는 도중 꺼져도 앞 내용이 남게) */
export function setSession(data: SessionData): void {
  if (!sessionOn()) return;
  const f = sessionFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(data), 'utf8');
  fs.renameSync(f + '.tmp', f);
}
