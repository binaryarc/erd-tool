// 마지막 화면 (STEP 10 결정 22. App.vue 에서 나눔, 2026-10-22).

import type SqlTab from '../components/SqlTab.vue';
import type { SessionData, SessionTab } from '../../../shared/ipc';
import { docTitle, newDoc } from '../erd-doc';
import { cleanError, type ErdDocs } from './useErdDocs';
import type { Tab, TopTabs } from './useTopTabs';

export function useSession(core: ErdDocs, top: TopTabs) {
  const { docs, cur, modelDir, errors, dirty, message, canvas, tab, membersOf, refreshDiagram, show } = core;
  const { tabs, activeTab, isErd, seqs, tabRefs, ask } = top;

  // ---------- 마지막 화면 (STEP 10 결정 22) ----------
  // ERD 탭(저장 안 한 변경, 보던 그룹 탭, 화면 위치), SQL 탭 글자와 접속, 위 탭 순서와 보던 탭을 session.json 에 담는다.
  // 2초마다 바뀐 것이 있으면 쓰고, 창을 닫을 때 한 번 더 쓴다. 비교, 내보내기 탭과 터미널은 담지 않는다.
  let restoring = true; // 되살리는 중에는 쓰지 않는다 (반쯤 연 화면으로 덮어쓰지 않게)
  let lastSession = '';
  const modelJson = new WeakMap<object, string>(); // 같은 모델은 다시 글자로 바꾸지 않는다

  function sessionNow(): SessionData {
    const out: SessionTab[] = [];
    for (const t of tabs.value) {
      const d = docs.get(t.id);
      if (d) {
        const viewport = d === cur.value && canvas.value ? canvas.value.viewportNow() : d.viewport;
        const m = d.model.value;
        // 확정 대기 중인 AI 변경도 저장 안 한 변경으로 담는다 (다시 켜면 강조 없이 바뀐 모델로 열린다)
        const unsaved = m && (d.dirty.value || d.aiBase.value) ? { model: m, layout: d.layout.value } : undefined;
        out.push({ kind: 'erd', id: t.id, modelDir: d.modelDir.value, diagram: d.tab.value, ...(viewport ? { viewport } : {}), ...(unsaved ? { unsaved } : {}) });
      } else if (t.kind === 'sql') {
        const tab = tabRefs.get(t.id) as InstanceType<typeof SqlTab> | undefined;
        const conn = tab?.connKey() || t.initialConn;
        out.push({ kind: 'sql', id: t.id, title: t.title, sql: tab?.text() ?? t.initialSql ?? '', ...(conn ? { conn } : {}) });
      }
    }
    const active = tabs.value.some(t => t.id === activeTab.value && (isErd(t.id) || t.kind === 'sql')) ? activeTab.value : cur.value.id;
    return { version: 1, active, tabs: out };
  }

  /** 바뀐 것이 있을 때만 쓴다 */
  async function saveSession() {
    if (restoring) return;
    const data = sessionNow();
    const key = JSON.stringify(data, (k, v) => {
      if (k === 'model' && v && typeof v === 'object') {
        let j = modelJson.get(v);
        if (!j) { j = JSON.stringify(v); modelJson.set(v, j); }
        return j; // 모델은 고칠 때마다 새 객체라 객체마다 한 번만 글자로 바꾼다
      }
      return v;
    });
    if (key === lastSession) return;
    lastSession = key;
    try { await window.erd.session.set(JSON.parse(JSON.stringify(data))); }
    catch (e) { message.value = `마지막 화면을 저장하지 못했습니다: ${cleanError(e)}`; }
  }
  setInterval(() => void saveSession(), 2000);

  /** 시작할 때: 마지막 화면이 있으면 그대로 연다. 없으면 설정의 모델 폴더만 고른 상태로 시작한다 (예전과 같다) */
  async function restoreSession() {
    try {
      const s = await window.erd.session.get();
      if (!s?.tabs.length) {
        const st = await window.erd.settings.get();
        if (st.modelDir) modelDir.value = st.modelDir;
        return;
      }
      const kept: Tab[] = [];
      const notes: string[] = [];
      for (const t of s.tabs) {
        if (t.kind === 'erd') {
          const d = t.id === 'erd' ? docs.get('erd')! : newDoc(t.id);
          docs.set(t.id, d);
          const n = Number(/^erd-(\d+)$/.exec(t.id)?.[1] ?? 1);
          seqs.erd = Math.max(seqs.erd, n);
          kept.push({ id: t.id, kind: 'erd', title: n > 1 ? `ERD ${n}` : 'ERD', dirty: false });
          d.modelDir.value = t.modelDir;
          if (t.viewport) d.viewport = t.viewport;
          cur.value = d;
          if (t.unsaved) {
            show(t.unsaved.model, t.unsaved.layout);
            dirty.value = true;
          } else if (t.modelDir) {
            try {
              const r = await window.erd.model.load(t.modelDir);
              errors.value = r.errors;
              show(r.model, r.layout);
            } catch (e) { notes.push(`${docTitle(d, 'ERD')}: ${cleanError(e)}`); }
          }
          if (d.model.value && membersOf(t.diagram)) { tab.value = t.diagram; refreshDiagram(); }
        } else {
          const n = Number(/^sql-(\d+)$/.exec(t.id)?.[1] ?? 0);
          seqs.sql = Math.max(seqs.sql, n);
          kept.push({ id: t.id, kind: 'sql', title: t.title, dirty: false, initialSql: t.sql, initialConn: t.conn });
        }
      }
      if (!kept.some(t => t.kind === 'erd')) kept.unshift(tabs.value[0]);
      for (const id of [...docs.keys()]) if (!kept.some(t => t.id === id)) docs.delete(id); // 닫았던 첫 ERD 탭
      tabs.value = kept;
      const first = kept.find(t => t.kind === 'erd')!;
      cur.value = docs.get(kept.some(t => t.id === s.active && isErd(t.id)) ? s.active : first.id)!;
      activeTab.value = kept.some(t => t.id === s.active) ? s.active : first.id;
      message.value = notes.length ? `마지막 화면을 열었습니다. 열지 못한 것: ${notes.join(', ')}` : '마지막 화면을 열었습니다';
    } finally {
      restoring = false;
    }
  }

  window.erd.onCloseRequest(async dirty => {
    await saveSession(); // 저장 안 한 ERD 변경은 마지막 화면에 담아 다시 켜면 돌아온다 (묻지 않는다)
    if (!dirty.length) { window.erd.confirmClose(true); return; }
    const a = await ask(dirty.map(d => tabs.value.find(t => t.id === d.tabId)?.title ?? d.label));
    if (a !== 'cancel') for (const d of dirty) await window.erd.sql[a](d.tabId);
    window.erd.confirmClose(a !== 'cancel');
  });

  /** 시험용: 바뀐 것이 없어도 지금 쓴다 */
  async function flushSession() { lastSession = ''; await saveSession(); }

  const restored = restoreSession();

  return { sessionNow, saveSession, restoreSession, flushSession, restored };
}

export type Session = ReturnType<typeof useSession>;
