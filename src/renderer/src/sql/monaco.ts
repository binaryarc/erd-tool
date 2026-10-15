// Monaco 설정과 SQL 힌트 (설계 9장). 자동완성, 회색 미리보기 공급자는 한 번만 등록하고,
// 편집기(텍스트 모델)마다 어느 스키마 모델과 쿼리 이력을 쓸지 contexts 에서 찾는다.
// API 는 monaco-editor 0.57.0 의 monaco.d.ts 로 확인 (STEP 1): registerCompletionItemProvider, registerInlineCompletionsProvider

import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { SchemaModel } from '../../../shared/model/types';
import type { HistoryEntry } from '../../../shared/ipc';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export interface EditorContext {
  schema: () => SchemaModel | null;
  history: () => HistoryEntry[];
}

const contexts = new Map<string, EditorContext>();
export const bindContext = (model: monaco.editor.ITextModel, ctx: EditorContext) => contexts.set(model.uri.toString(), ctx);
export const unbindContext = (model: monaco.editor.ITextModel) => contexts.delete(model.uri.toString());

const KEYWORDS = ['select', 'from', 'where', 'join', 'left join', 'inner join', 'on', 'group by', 'order by', 'having', 'limit',
  'insert into', 'values', 'update', 'set', 'delete from', 'and', 'or', 'not', 'in', 'exists', 'between', 'like', 'is null',
  'is not null', 'distinct', 'count(*)', 'as', 'case', 'when', 'then', 'else', 'end', 'commit', 'rollback'];

/** from/join 뒤 「테이블 별칭」을 찾아 별칭 → 테이블 (별칭 없으면 테이블 이름 자신) */
export function aliasMap(sql: string, schema: SchemaModel): Map<string, string> {
  const names = new Set(schema.tables.map(t => t.name));
  const map = new Map<string, string>();
  const re = /\b(?:from|join|update|into)\s+([a-z_][\w]*)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi;
  for (const m of sql.matchAll(re)) {
    const table = m[1].toLowerCase();
    if (!names.has(table)) continue;
    map.set(table, table);
    const alias = m[2]?.toLowerCase();
    if (alias && !/^(where|join|left|right|inner|outer|on|set|order|group|limit|values|cross|full)$/.test(alias)) map.set(alias, table);
  }
  return map;
}

let registered = false;

export function registerSqlProviders() {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const schema = contexts.get(model.uri.toString())?.schema();
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const K = monaco.languages.CompletionItemKind;
      if (!schema) return { suggestions: KEYWORDS.map(k => ({ label: k, kind: K.Keyword, insertText: k, range })) };

      const byName = new Map(schema.tables.map(t => [t.name, t]));
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      const dot = before.match(/([a-z_]\w*)\.$/i);
      const aliases = aliasMap(model.getValue(), schema);
      if (dot) {
        // 별칭.  또는  테이블.  → 그 테이블 컬럼
        const t = byName.get(aliases.get(dot[1].toLowerCase()) ?? dot[1].toLowerCase());
        return { suggestions: (t?.columns ?? []).map(c => ({
          label: c.name, kind: K.Field, insertText: c.name, range, detail: c.type, documentation: c.comment,
        })) };
      }
      const used = new Set(aliases.values());
      return { suggestions: [
        ...schema.tables.map(t => ({ label: t.name, kind: K.Struct, insertText: t.name, range, detail: t.comment, sortText: '1' + t.name })),
        // 쿼리에 나온 테이블의 컬럼은 앞에
        ...[...used].flatMap(n => (byName.get(n)?.columns ?? []).map(c => ({
          label: c.name, kind: K.Field, insertText: c.name, range, detail: `${n} ${c.type}`, documentation: c.comment, sortText: '0' + c.name,
        }))),
        ...KEYWORDS.map(k => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: '2' + k })),
      ] };
    },
  });

  // 회색 미리보기: 지금 줄의 앞부분과 같게 시작하는, 많이 쓴 이력 문장 (Tab 으로 받기)
  monaco.languages.registerInlineCompletionsProvider('sql', {
    provideInlineCompletions(model, position) {
      const history = contexts.get(model.uri.toString())?.history() ?? [];
      const typed = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      if (typed.trim().length < 2) return { items: [] };
      const lower = typed.toLowerCase();
      const hit = [...history].sort((a, b) => b.count - a.count)
        .find(h => h.sql.toLowerCase().startsWith(lower) && h.sql.length > typed.length);
      return { items: hit ? [{ insertText: hit.sql, range: { startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column } }] : [] };
    },
    disposeInlineCompletions() {},
  });
}

export { monaco };
