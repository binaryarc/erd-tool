// 시험 모드(ERD_AUTO) 시나리오 실행부 (2026-10-22 index.ts 에서 옮김). 설치용 빌드에는 들어가지 않는다(__ERD_AUTO__).
// ERD_AUTO 에 적은 시나리오를 화면에서 돌리고 결과(JSON)를 출력한 뒤 종료한다

import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { forgetSessionPasswords, listManual, profileSecretStore, removeManual, saveManual } from '../db/manual';
import { testConnection } from '../db/reverse';
import { getProfile, passwordOf } from '../db/profiles';
import { step10Inputs } from './step10';

export function runAuto(win: BrowserWindow) {
  // 시험 모드: ERD_AUTO 에 적은 시나리오를 화면에서 돌리고 결과(JSON)를 출력한 뒤 종료한다
  //   ERD_AUTO=reverse  ERD_BE_DIR, ERD_PROFILE, ERD_MODEL_DIR 로 리버스 → 저장 → 캔버스 노드 수, fps
  const auto = process.env.ERD_AUTO;
  //   ERD_AUTO=manual  ERD_BE_DIR 의 dev 접속 정보로 직접 입력 접속을 만들어 비밀번호 저장, 복호화, 접속을 확인하고 지운다
  if (auto === 'manual') {
    win.webContents.once('did-finish-load', async () => {
      try { console.log('[auto]', JSON.stringify(await manualScenario(process.env.ERD_BE_DIR!))); }
      catch (e) { console.log('[auto] 실패', (e as Error).message); }
      app.quit();
    });
    return;
  }
  if (auto) {
    // 시험 모드에서는 화면 쪽 오류와 불러오기 실패를 그대로 출력한다 (멈춘 곳을 찾기 위해)
    win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 'warning') console.log('[renderer]', e.level, e.message.slice(0, 300)); });
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[load-fail]', code, desc));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer-gone]', d.reason, d.exitCode));
    win.webContents.once('did-finish-load', async () => {
      console.log('[loaded]');
      const args = { scenario: auto, beDir: process.env.ERD_BE_DIR, profile: process.env.ERD_PROFILE ?? 'dev', modelDir: process.env.ERD_MODEL_DIR, exportDir: process.env.ERD_EXPORT_DIR, measure: process.env.ERD_MEASURE, dbms: process.env.ERD_DBMS, part: process.env.ERD_STEP10 };
      //   ERD_AUTO=step7  ERD_EXPORT_DIR(시험용 임시 폴더)에 Flyway, 이력, MD 파일을 만든다. 이력 파일은 「변경 이력」 표만 든 시험용 파일을 그 폴더에 만들어 쓴다
      if (auto === 'step7' && args.exportDir) {
        fs.mkdirSync(args.exportDir, { recursive: true });
        fs.writeFileSync(path.join(args.exportDir, 'migration-history.md'), '# 마이그레이션 이력\n\n## 변경 이력\n\n| 반영일시 | 메뉴 | 테이블 | 내용 | 반영자 | 비고 |\n|---|---|---|---|---|---|\n');
      }
      try {
        // 화면은 시험 함수(src/renderer/src/auto)를 나중에 불러 붙이므로 생길 때까지 기다린다
        await win.webContents.executeJavaScript('new Promise(r => { const f = () => (window.__erdAuto ? r(true) : setTimeout(f, 20)); f(); })');
        const out = await win.webContents.executeJavaScript(`window.__erdAuto(${JSON.stringify(args)})`);
        console.log('[auto]', JSON.stringify(out));
        //   ERD_AUTO=sql  SQL 탭, 터미널 탭 시험. ERD_SHOT 을 주면 두 탭 화면을 남긴다
        //   ERD_AUTO=step5  DB 비교, ERD 차이 적용(전체 실행 후 롤백). ERD_SHOT 을 주면 비교 탭과 적용 탭 화면을 남긴다
        //   ERD_AUTO=step6  ERD 수정 → dev 적용(커밋) → 다시 읽어 차이 0 → 되돌리기로 시험 테이블 지움. ERD_SHOT 을 주면 편집 화면을 남긴다
        //   ERD_AUTO=dbms  ERD_DBMS(JSON 배열: 직접 입력 접속과 비밀번호, 시험 SQL)마다 접속 시험 → 리버스 → 저장 → 캔버스 → SQL 탭 조회. ERD_SHOT 이면 DB 마다 화면을 남긴다
        if (auto === 'dbms') {
          const shot = process.env.ERD_SHOT;
          if (shot) fs.writeFileSync(`${shot}-dbms.png`, (await win.webContents.capturePage()).toPNG());
          app.quit();
          return;
        }
        //   ERD_AUTO=step10  편집 편의 기능을 실제 키보드, 마우스 입력으로 시험한다. ERD_STEP10 에 고를 부분(enter), ERD_SHOT 이면 화면을 남긴다
        if (auto === 'step10') {
          console.log('[step10]', JSON.stringify(await step10Inputs(win, process.env.ERD_STEP10 ?? 'enter')));
          const shot = process.env.ERD_SHOT;
          if (shot) fs.writeFileSync(`${shot}-step10.png`, (await win.webContents.capturePage()).toPNG());
          if (process.env.ERD_STEP10 === 'session1') win.close(); // X 버튼과 같은 길: 화면이 마지막 화면을 쓰고 닫힌다
          else app.quit();
          return;
        }
        //   ERD_AUTO=suggest  SQL 탭 자동완성 목록의 항목 글자와 색을 재고, ERD_SHOT 이면 화면을 남긴다
        if (auto === 'suggest') {
          const shot = process.env.ERD_SHOT;
          if (shot) fs.writeFileSync(`${shot}-suggest.png`, (await win.webContents.capturePage()).toPNG());
          app.quit();
          return;
        }
        //   ERD_AUTO=mcp  모델을 열고 ERD_MEASURE 밀리초(기본 60초) 기다린다. 그동안 밖에서 MCP 도구를 직접 불러 본다
        //   ERD_AUTO=password  비밀번호 창(자동 실패, 틀림, 취소). 끝에 비밀번호 저장소(Windows 계정 암호화)에 시험 값을 넣고 읽고 지운다
        if (auto === 'password') {
          const k = 'be:erd-tool-store-probe:dev';
          await profileSecretStore.save(k, 'probe-value');
          const secretsText = fs.readFileSync(path.join(app.getPath('userData'), 'secrets.json'), 'utf8');
          const store = { plainInFile: secretsText.includes('probe-value'), has: profileSecretStore.has(k), loaded: (await profileSecretStore.load(k)) === 'probe-value' };
          await profileSecretStore.remove(k);
          console.log('[store]', JSON.stringify({ ...store, removed: !profileSecretStore.has(k) }));
          app.quit();
          return;
        }
        //   ERD_AUTO=step8  실제 claude 로 AI 변경 → 강조, 다른 테이블 위치 그대로 확인. ERD_SHOT 이면 확정 대기 화면을 남기고, 끝에 취소한다
        if (auto === 'step8') {
          const shot = process.env.ERD_SHOT;
          if (shot && !process.env.ERD_MEASURE) fs.writeFileSync(`${shot}-pending.png`, (await win.webContents.capturePage()).toPNG());
          console.log('[cancel]', JSON.stringify(await win.webContents.executeJavaScript('window.__erdAiCancel()')));
          app.quit();
          return;
        }
        if (auto === 'step7') {
          const shot = process.env.ERD_SHOT;
          if (shot) {
            for (const id of ['compare', 'export']) {
              await win.webContents.executeJavaScript(`window.__erdActivate(${JSON.stringify(id)})`);
              fs.writeFileSync(`${shot}-${id}.png`, (await win.webContents.capturePage()).toPNG());
            }
          }
          app.quit();
          return;
        }
        if (auto === 'step6') {
          const shot = process.env.ERD_SHOT;
          if (shot) {
            console.log('[shot]', JSON.stringify(await win.webContents.executeJavaScript('window.__erdStep6Shot()')));
            fs.writeFileSync(`${shot}-edit.png`, (await win.webContents.capturePage()).toPNG());
          }
          app.quit();
          return;
        }
        if (auto === 'step5') {
          const shot = process.env.ERD_SHOT;
          if (shot) {
            for (const [name, id] of [['compare', 'compare'], ['apply', (out.tabs as Record<string, string>).apply]]) {
              await win.webContents.executeJavaScript(`window.__erdActivate(${JSON.stringify(id)})`);
              fs.writeFileSync(`${shot}-${name}.png`, (await win.webContents.capturePage()).toPNG());
            }
          }
          app.quit();
          return;
        }
        if (auto === 'sql') {
          // 경계선 끌기: 실제 마우스 입력으로 터미널 위 경계선을 100px 올리고, 왼쪽 패널 경계선을 80px 오른쪽으로
          const js = (s: string) => win.webContents.executeJavaScript(s);
          const rect = (sel: string) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
          const drag = async (x: number, y: number, dx: number, dy: number) => {
            const ev = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', px: number, py: number) =>
              win.webContents.sendInputEvent({ type, x: Math.round(px), y: Math.round(py), button: 'left', clickCount: 1 });
            ev('mouseDown', x, y);
            for (let i = 1; i <= 5; i++) { ev('mouseMove', x + (dx * i) / 5, y + (dy * i) / 5); await new Promise(r => setTimeout(r, 30)); }
            ev('mouseUp', x + dx, y + dy);
            await new Promise(r => setTimeout(r, 300));
          };
          const termBefore = await rect('.term-panel');
          const leftBefore = await rect('.panel');
          await drag(termBefore.x + 200, termBefore.y - 2, 0, -100);
          await drag(leftBefore.x + leftBefore.w + 2, leftBefore.y + 200, 80, 0);
          const termAfter = await rect('.term-panel');
          const leftAfter = await rect('.panel');
          console.log('[resize]', JSON.stringify({
            terminalHeight: [Math.round(termBefore.h), Math.round(termAfter.h)], leftWidth: [Math.round(leftBefore.w), Math.round(leftAfter.w)],
            saved: await js(`[localStorage.getItem('split:terminal'), localStorage.getItem('split:left')]`),
          }));

          // SQL 결과 그리드 촘촘함
          await js(`window.__erdActivate('sql-1')`);
          console.log('[grid]', JSON.stringify(await js('window.__erdGrid()')));

          // ERD: 트리 정렬, 직선, 한 번 클릭 → 선택 테두리, 더블클릭 → 미니 ERD
          await js(`window.__erdActivate('erd')`);
          console.log('[tree]', JSON.stringify(await js(`window.__erdView({ mode: 'tree', edge: 'straight' })`)));
          await js(`window.__erdView({ mode: 'tree' })`);
          await new Promise(r => setTimeout(r, 1000));
          const p = await js(`window.__erdNodeRect('mst_center')`);
          if (p) {
            console.log('[hit]', JSON.stringify(await js(`(() => { const e = document.elementFromPoint(${Math.round(p.x)}, ${Math.round(p.y)});
              return { at: [${Math.round(p.x)}, ${Math.round(p.y)}], el: e?.tagName + '.' + e?.className, node: e?.closest('.vue-flow__node')?.className ?? null }; })()`)));
            const click = (count: number) => {
              win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: count });
              win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: count });
            };
            click(1);
            await new Promise(r => setTimeout(r, 400));
            const afterClick = await js('window.__erdInspect()');
            click(1); click(2);
            await new Promise(r => setTimeout(r, 1500));
            console.log('[select]', JSON.stringify({ afterClick, afterDouble: await js('window.__erdInspect()') }));
          } else console.log('[select] mst_center 노드를 화면에서 찾지 못함');
          const shot = process.env.ERD_SHOT;
          if (shot) {
            for (const [name, id] of Object.entries(out.tabs as Record<string, string>)) {
              await win.webContents.executeJavaScript(`window.__erdActivate(${JSON.stringify(id)})`);
              fs.writeFileSync(`${shot}-${name}.png`, (await win.webContents.capturePage()).toPNG());
            }
          }
          app.quit();
          return;
        }
        // ERD_SHOT 을 주면 처음 화면(전체 보기)과 100% 확대 화면을 PNG 로 남긴다
        const shot = process.env.ERD_SHOT;
        if (shot) {
          fs.writeFileSync(shot + '-fit.png', (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript(`document.querySelector('.vue-flow__controls-zoomin')?.click()`);
          for (let i = 0; i < 6; i++) await win.webContents.executeJavaScript(`document.querySelector('.vue-flow__controls-zoomin')?.click()`);
          await new Promise(r => setTimeout(r, 800));
          fs.writeFileSync(shot + '-zoom.png', (await win.webContents.capturePage()).toPNG());
        }
        console.log('[bench]', JSON.stringify(await win.webContents.executeJavaScript('window.__erdBench()')));
      } catch (e) {
        console.log('[auto] 실패', (e as Error).message);
      }
      app.quit();
    });
  }
}

async function manualScenario(beDir: string) {
  const p = getProfile(beDir, 'dev');
  const pw = passwordOf(p, beDir);
  const base = { id: '', name: '시험 접속', driver: p.dialect ?? 'postgresql', host: p.host, port: p.port, database: p.database, user: p.user, readOnly: true };
  const secretsFile = path.join(app.getPath('userData'), 'secrets.json');
  const out: Record<string, unknown> = {};

  // 1) 저장함: 암호화 파일에 평문이 없고, 메모리를 비워도 복호화해 접속된다
  const saved = await saveManual({ ...base, savePassword: true }, pw);
  const secrets = fs.readFileSync(secretsFile, 'utf8');
  out.secretHasPlain = secrets.includes(pw);
  out.secretSaved = saved.id in JSON.parse(secrets);
  forgetSessionPasswords();
  out.savedTest = (await testConnection({ source: 'manual', id: saved.id })).ok;

  // 2) 저장 안 함으로 바꿈: 파일에서 지워지고, 메모리를 비우면 비밀번호를 다시 요구한다
  await saveManual({ ...saved, savePassword: false });
  out.secretRemoved = !(saved.id in JSON.parse(fs.readFileSync(secretsFile, 'utf8')));
  out.sessionTest = (await testConnection({ source: 'manual', id: saved.id })).ok;
  forgetSessionPasswords();
  const after = await testConnection({ source: 'manual', id: saved.id });
  out.afterRestart = after.ok ? '접속됨(잘못)' : after.message;

  removeManual(saved.id);
  out.listAfterRemove = listManual().length;
  return out;
}
