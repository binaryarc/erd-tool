// Monaco 설정과 SQL 힌트 (설계 9장). 자동완성, 회색 미리보기 공급자는 한 번만 등록하고,
// 편집기(텍스트 모델)마다 어느 DB 목록과 쿼리 이력을 쓸지 contexts 에서 찾는다.
// 무엇을 추천할지는 shared/sql/complete.ts 가 정한다 (단위 시험 대상).
// API 는 monaco-editor 0.57.0 의 monaco.d.ts 로 확인 (STEP 1): registerCompletionItemProvider, registerInlineCompletionsProvider

import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { SchemaModel } from '../../../shared/model/types';
import type { HistoryEntry, SqlCatalog } from '../../../shared/ipc';
import { suggest, type ItemKind } from '../../../shared/sql/complete';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export interface EditorContext {
  /** 접속한 DB 에서 읽은 목록, 없으면 ERD 모델로 만든 목록 */
  catalog: () => SqlCatalog | null;
  history: () => HistoryEntry[];
}

const contexts = new Map<string, EditorContext>();
export const bindContext = (model: monaco.editor.ITextModel, ctx: EditorContext) => contexts.set(model.uri.toString(), ctx);
export const unbindContext = (model: monaco.editor.ITextModel) => contexts.delete(model.uri.toString());

/** ERD 모델을 자동완성 목록 모양으로 (DB 목록을 아직 못 읽었을 때) */
export const catalogFromModel = (m: SchemaModel): SqlCatalog => ({
  dialect: m.dialect,
  tables: m.tables.map(t => ({ name: t.name, schema: m.schema ?? 'public', kind: 'table', comment: t.comment,
    columns: t.columns.map(c => ({ name: c.name, type: c.type, comment: c.comment ?? '' })) })),
  functions: m.functions.map(f => ({ name: f.name, args: f.args, returns: '' })),
});

const EMPTY: SqlCatalog = { tables: [], functions: [] };

/** 접속 구분 값 → DB 목록. SQL 탭끼리 같이 쓴다 (같은 DB 를 탭마다 다시 읽지 않게) */
export const catalogCache = new Map<string, SqlCatalog>();

let registered = false;

export function registerSqlProviders() {
  if (registered) return;
  registered = true;
  const K = monaco.languages.CompletionItemKind;
  const kinds: Record<ItemKind, monaco.languages.CompletionItemKind> = {
    table: K.Struct, view: K.Interface, column: K.Field, function: K.Function, keyword: K.Keyword, snippet: K.Snippet,
  };

  monaco.languages.registerCompletionItemProvider('sql', {
    // 이 글자를 치면 바로 목록을 연다 (글자를 칠 때는 quickSuggestions 로 열린다)
    triggerCharacters: ['.', ' ', ','],
    provideCompletionItems(model, position) {
      const offset = model.getOffsetAt(position);
      const text = model.getValue();
      const items = suggest(text.slice(0, offset), text.slice(offset), contexts.get(model.uri.toString())?.catalog() ?? EMPTY);
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return {
        suggestions: items.map(i => ({
          label: i.label, kind: kinds[i.kind], insertText: i.insert, detail: i.detail, documentation: i.doc, sortText: i.sort, range,
          insertTextRules: i.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        })),
      };
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
