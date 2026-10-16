// AI 변경 명령 (STEP 8, 설계 10-4). 한 줄에 명령 하나. 하나라도 실패하면 아무것도 적용하지 않는다(새 모델만 돌려주고 원래 모델은 그대로).
// 실제 수정은 화면 편집과 같은 shared/model/edit.ts 가 한다. 배치(place)는 좌표를 받지 않고 「어느 테이블 옆」만 받는다.
//
//   add_table 이름 [+common] [#코멘트]
//   add_column 테이블.컬럼 타입 [PK] [NN] [=기본값] [#코멘트]
//   alter_column 테이블.컬럼 타입 [PK] [NN] [=기본값] [#코멘트]   (코멘트를 빼면 원래 코멘트를 둔다)
//   drop_column 테이블.컬럼 | drop_table 테이블
//   rename 테이블 -> 새이름 | rename 테이블.컬럼 -> 새이름
//   comment 테이블[.컬럼] #코멘트
//   add_fk 테이블.컬럼[,컬럼] -> 참조테이블.컬럼[,컬럼] [name=이름] | drop_fk 테이블 FK이름
//   place 테이블 after=기준테이블 [group=그룹]

import { groupOf, parseColumn } from '../model/erd-format';
import * as E from '../model/edit';
import type { SchemaModel } from '../model/types';

export const MAX_COMMANDS = 50;

export class CommandError extends Error {}

export interface PlaceRequest { table: string; after: string }
export interface CommandResult { model: SchemaModel; places: PlaceRequest[]; done: string[] }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function splitDot(s: string, what: string): [string, string] {
  const i = s.indexOf('.');
  if (i <= 0 || i === s.length - 1) throw new CommandError(`${what} 은(는) 테이블.컬럼 모양이어야 한다: ${s}`);
  return [s.slice(0, i), s.slice(i + 1)];
}

function column(body: string) {
  let error = '';
  const c = parseColumn(body, m => { error = m; });
  if (!c) throw new CommandError(error || `컬럼 정의를 읽지 못했다: ${body}`);
  return c;
}

function one(m: SchemaModel, line: string, places: PlaceRequest[]): SchemaModel {
  const [cmd, ...restWords] = line.split(/\s+/);
  const rest = line.slice(cmd.length).trim();
  switch (cmd) {
    case 'add_table': {
      const hash = rest.indexOf('#');
      const head = (hash >= 0 ? rest.slice(0, hash) : rest).trim().split(/\s+/);
      const name = head[0];
      if (!IDENT.test(name ?? '')) throw new CommandError(`테이블 이름이 아니다: ${name}`);
      return E.addTable(m, name, { comment: hash >= 0 ? rest.slice(hash + 1).trim() : '', withCommon: head.includes('+common') });
    }
    case 'add_column':
    case 'alter_column': {
      const target = restWords[0] ?? '';
      const [t, c] = splitDot(target, '대상');
      const def = column(c + rest.slice(target.length));
      if (cmd === 'add_column') return E.addColumn(m, t, { ...def.column, pk: def.pk });
      const old = m.tables.find(x => x.name === t)?.columns.find(x => x.name === c);
      return E.updateColumn(m, t, c, {
        type: def.column.type, notNull: def.column.notNull, pk: def.pk,
        default: def.column.default ?? '', comment: def.column.comment ?? old?.comment ?? '',
      });
    }
    case 'drop_column': { const [t, c] = splitDot(rest, '대상'); return E.dropColumn(m, t, c); }
    case 'drop_table': return E.dropTable(m, rest);
    case 'rename': {
      const r = rest.match(/^(\S+)\s*->\s*(\S+)$/);
      if (!r) throw new CommandError('rename 대상 -> 새이름 모양이어야 한다');
      if (!IDENT.test(r[2])) throw new CommandError(`새 이름이 아니다: ${r[2]}`);
      if (!r[1].includes('.')) return E.updateTable(m, r[1], { name: r[2] });
      const [t, c] = splitDot(r[1], '대상');
      return E.updateColumn(m, t, c, { name: r[2] });
    }
    case 'comment': {
      const r = rest.match(/^(\S+)\s+#(.*)$/);
      if (!r) throw new CommandError('comment 대상 #코멘트 모양이어야 한다');
      if (!r[1].includes('.')) return E.updateTable(m, r[1], { comment: r[2].trim() });
      const [t, c] = splitDot(r[1], '대상');
      return E.updateColumn(m, t, c, { comment: r[2].trim() });
    }
    case 'add_fk': {
      const r = rest.match(/^(\S+)\s*->\s*(\S+)(?:\s+name=(\S+))?$/);
      if (!r) throw new CommandError('add_fk 테이블.컬럼 -> 참조테이블.컬럼 [name=이름] 모양이어야 한다');
      const [t, cs] = splitDot(r[1], 'FK 컬럼');
      const [rt, rcs] = splitDot(r[2], '참조 컬럼');
      return E.addFk(m, t, { name: r[3] ?? E.defaultFkName(m, t, rt), columns: cs.split(','), refTable: rt, refColumns: rcs.split(',') });
    }
    case 'drop_fk': {
      if (restWords.length !== 2) throw new CommandError('drop_fk 테이블 FK이름 모양이어야 한다');
      return E.dropFk(m, restWords[0], restWords[1]);
    }
    case 'place': {
      const t = restWords[0];
      const opts = Object.fromEntries(restWords.slice(1).map(w => w.split('=')));
      if (!m.tables.some(x => x.name === t)) throw new CommandError(`테이블 ${t} 이 없다`);
      if (!opts.after) throw new CommandError('place 는 after=기준테이블 이 있어야 한다 (좌표는 받지 않는다)');
      if (!m.tables.some(x => x.name === opts.after)) throw new CommandError(`기준 테이블 ${opts.after} 이 없다`);
      if (opts.group && opts.group.toLowerCase() !== groupOf(t, m.groups).toLowerCase())
        throw new CommandError(`${t} 의 그룹은 ${groupOf(t, m.groups)} 다 (그룹은 이름 접두어로 정해진다)`);
      places.push({ table: t, after: opts.after });
      return m;
    }
    default:
      throw new CommandError(`모르는 명령: ${cmd}`);
  }
}

/** 명령 줄들을 차례로 적용한 새 모델. 실패하면 「줄 번호: 이유」 로 CommandError 를 던진다 */
export function applyCommands(model: SchemaModel, lines: string[]): CommandResult {
  const list = lines.map(l => l.trim()).filter(Boolean);
  if (!list.length) throw new CommandError('명령이 없다');
  if (list.length > MAX_COMMANDS) throw new CommandError(`한 번에 ${MAX_COMMANDS}줄까지 (지금 ${list.length}줄). 나눠서 보내세요`);
  let m = model;
  const places: PlaceRequest[] = [];
  list.forEach((line, i) => {
    try { m = one(m, line, places); }
    catch (e) {
      if (e instanceof CommandError || e instanceof E.EditError) throw new CommandError(`${i + 1}줄 「${line}」: ${e.message}`);
      throw e;
    }
  });
  // place 뒤에 rename 이 오면 이름이 바뀌었을 수 있다
  for (const p of places) {
    if (!m.tables.some(t => t.name === p.table) || !m.tables.some(t => t.name === p.after)) throw new CommandError(`place ${p.table} after=${p.after}: 명령을 다 적용한 뒤 그 테이블이 없다`);
  }
  return { model: m, places, done: list };
}
