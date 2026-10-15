// 접속 고르기 목록: BE 폴더 프로필 + 직접 입력 접속 (SQL 탭, DB 비교 화면이 같이 쓴다)
import type { ConnRef } from '../../shared/ipc';

export interface ConnOption { key: string; label: string; ref: ConnRef; readOnly: boolean; profile?: string }

export async function loadConnOptions(): Promise<ConnOption[]> {
  const s = await window.erd.settings.get();
  const be = s.beDir ? (await window.erd.conn.list(s.beDir)).map(p => ({
    key: 'be:' + p.name, label: `${p.name} (${p.database})`, readOnly: p.readOnly, profile: p.name,
    ref: { source: 'be', beDir: s.beDir!, name: p.name } as ConnRef,
  })) : [];
  const manual = (await window.erd.manual.list()).map(c => ({
    key: 'manual:' + c.id, label: `${c.name} (${c.database})`, readOnly: c.readOnly, ref: { source: 'manual', id: c.id } as ConnRef,
  }));
  return [...be, ...manual];
}
