// 위 영역 탭(ERD, SQL, DB 비교, 내보내기), 아래 터미널, 확인 창, 비밀번호 창, 탭 닫기 (App.vue 에서 나눔, 2026-10-22).

import { ref, watch } from 'vue';
import type TerminalPanel from '../components/TerminalPanel.vue';
import type { ShellKind } from '../../../shared/ipc';
import { docTitle, newDoc } from '../erd-doc';
import type { ErdDocs } from './useErdDocs';

export interface Tab { id: string; kind: 'erd' | 'sql' | 'compare' | 'export'; title: string; dirty: boolean; initialSql?: string; initialConn?: string }

/** onErdClosed: ERD 탭을 닫은 뒤 (AI 연결을 푼다) */
export function useTopTabs(core: ErdDocs, onErdClosed: (id: string) => void) {
  const { docs, cur, canvas, selected, keepViewport } = core;

  const NL = '\n';
  // 확인 창 (window.confirm 대신: 시험 모드에서 막히지 않고 버튼을 여러 개 둘 수 있다)
  const dlg = ref<{ text: string; buttons: { label: string; value: string }[]; resolve: (v: string) => void } | null>(null);
  const askDlg = (text: string, buttons: { label: string; value: string }[]) =>
    new Promise<string>(resolve => { dlg.value?.resolve(''); dlg.value = { text, buttons, resolve }; });
  function answerDlg(v: string) { const d = dlg.value; dlg.value = null; d?.resolve(v); }

  // ---------- 위 영역 탭: ERD, SQL / 아래 영역: 터미널 ----------
  const tabs = ref<Tab[]>([{ id: 'erd', kind: 'erd', title: 'ERD', dirty: false }]);
  const activeTab = ref('erd');
  const isErd = (id: string) => docs.has(id);
  /** ERD 탭 제목: 모델 폴더(BE 레포 이름), 없으면 ERD n */
  const titleOf = (id: string) => docTitle(docs.get(id)!, tabs.value.find(t => t.id === id)?.title ?? 'ERD');
  /** 새 탭 번호 (마지막 화면을 되살릴 때 이어 받는다) */
  const seqs = { erd: 1, sql: 0 };

  // ERD 탭을 고르면 그 탭의 상태로 바꾼다. 떠나는 탭의 화면 위치를 남겨 돌아오면 그 자리로 연다 (캔버스는 탭마다 새로 만든다)
  watch(activeTab, id => {
    const d = docs.get(id);
    if (!d || d === cur.value) return;
    if (canvas.value) { keepViewport(); cur.value.viewport = canvas.value.viewportNow(); }
    cur.value = d;
    selected.value = [];
  });

  /** 새 ERD 탭 (빈 상태. ERD 폴더 열기나 DB 에서 불러오기로 채운다) */
  function addErd(): string {
    const id = `erd-${++seqs.erd}`;
    docs.set(id, newDoc(id));
    const at = tabs.value.map(t => t.kind).lastIndexOf('erd') + 1;
    tabs.value.splice(at, 0, { id, kind: 'erd', title: `ERD ${seqs.erd}`, dirty: false });
    activeTab.value = id;
    return id;
  }
  const tabRefs = new Map<string, unknown>();
  const setTabRef = (id: string, el: unknown) => { if (el) tabRefs.set(id, el); else tabRefs.delete(id); };

  /** DB 비교 탭은 하나만 연다 */
  function openCompare() {
    if (!tabs.value.some(t => t.id === 'compare')) tabs.value.splice(1, 0, { id: 'compare', kind: 'compare', title: 'DB 비교', dirty: false });
    activeTab.value = 'compare';
  }

  /** 내보내기 탭도 하나만 연다 (STEP 7) */
  function openExport() {
    if (!tabs.value.some(t => t.id === 'export')) tabs.value.push({ id: 'export', kind: 'export', title: '내보내기', dirty: false });
    activeTab.value = 'export';
  }

  function addSql(initialSql = '', initialConn?: string) {
    const id = `sql-${++seqs.sql}`;
    tabs.value.push({ id, kind: 'sql', title: `SQL ${seqs.sql}`, dirty: false, initialSql, initialConn });
    activeTab.value = id;
    return id;
  }

  // 아래 터미널 영역 (VS Code 처럼). Ctrl+` 로 보이기, 숨기기
  const terminals = ref<InstanceType<typeof TerminalPanel>>();
  const termVisible = ref(false);
  async function addTerm(shell: ShellKind) {
    termVisible.value = true;
    return terminals.value!.add(shell);
  }
  function toggleTerm() {
    termVisible.value = !termVisible.value;
    if (termVisible.value && !terminals.value!.terms.length) void terminals.value!.add('powershell');
  }

  /** 커밋 안 한 변경 확인 (탭 닫기, 창 닫기 공통) */
  /** BE 프로필 비밀번호 입력 창 (자동으로 풀지 못했거나 DB 가 거부했을 때 메인이 묻는다) */
  const pwAsk = ref<{ id: number; label: string; reason: string } | null>(null);
  const pwInput = ref({ password: '', save: false });
  const pwQueue: { id: number; label: string; reason: string }[] = [];
  function nextPw() {
    pwAsk.value = pwQueue.shift() ?? null;
    pwInput.value = { password: '', save: false };
  }
  window.erd.password.onAsk((id, req) => { pwQueue.push({ id, ...req }); if (!pwAsk.value) nextPw(); });
  function answerPw(ok: boolean) {
    if (!pwAsk.value) return;
    window.erd.password.reply(pwAsk.value.id, ok ? { password: pwInput.value.password, save: pwInput.value.save } : null);
    nextPw();
  }

  const closeAsk = ref<{ labels: string[]; resolve: (a: 'commit' | 'rollback' | 'cancel') => void } | null>(null);
  const ask = (labels: string[]) => new Promise<'commit' | 'rollback' | 'cancel'>(resolve => { closeAsk.value = { labels, resolve }; });
  function answerClose(a: 'commit' | 'rollback' | 'cancel') { closeAsk.value?.resolve(a); closeAsk.value = null; }

  async function closeTab(t: Tab) {
    if (t.kind === 'erd') {
      const d = docs.get(t.id)!;
      if (tabs.value.filter(x => x.kind === 'erd').length < 2) return; // ERD 탭은 하나는 남긴다
      if ((d.dirty.value || d.aiBase.value) && await askDlg(`${titleOf(t.id)} 탭에 저장하지 않은 ERD 변경이 있습니다${d.aiBase.value ? ' (확정 대기 중인 AI 변경 포함)' : ''}.` + NL + '탭을 닫으면 이 변경은 사라집니다.',
        [{ label: '닫기', value: 'ok' }, { label: '취소', value: '' }]) !== 'ok') return;
      if (cur.value === d) { // 닫는 탭이 지금 ERD 탭이면 다른 ERD 탭을 먼저 지금 탭으로
        const next = tabs.value.filter(x => x.kind === 'erd' && x.id !== t.id).at(-1)!;
        cur.value = docs.get(next.id)!;
        if (activeTab.value === t.id) activeTab.value = next.id;
      }
      docs.delete(t.id);
      onErdClosed(t.id);
    }
    if (t.kind === 'sql') {
      if (t.dirty) {
        const a = await ask([t.title]);
        if (a === 'cancel') return;
        await window.erd.sql[a](t.id);
      }
      await window.erd.sql.close(t.id);
    }
    tabs.value = tabs.value.filter(x => x.id !== t.id);
    if (activeTab.value === t.id) activeTab.value = tabs.value[tabs.value.length - 1].id;
  }

  // X 버튼이 아닌 길(window.close(), 새로 고침)로 화면이 내려가려 하면 막는다. 막으면 메인이 창으로 묻는다(will-prevent-unload).
  // X 버튼은 메인이 먼저 묻고 확인하면 여기서 막아도 메인이 통과시킨다.
  // 저장 안 한 ERD 변경은 마지막 화면(session.json)에 2초마다 담기므로 막지 않는다 (STEP 10 결정 22)
  window.addEventListener('beforeunload', e => {
    if (tabs.value.some(t => t.dirty)) e.returnValue = false;
  });

  return { dlg, askDlg, answerDlg, tabs, activeTab, isErd, titleOf, seqs, addErd, tabRefs, setTabRef, openCompare, openExport, addSql, terminals, termVisible, addTerm, toggleTerm, pwAsk, pwInput, pwQueue, nextPw, answerPw, closeAsk, ask, answerClose, closeTab };
}

export type TopTabs = ReturnType<typeof useTopTabs>;
