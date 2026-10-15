<script setup>
// Monaco 시험: 테이블, 컬럼 자동완성(registerCompletionItemProvider)과
// 쿼리 이력 회색 미리보기(registerInlineCompletionsProvider, Tab 으로 받기).
import { onMounted, ref } from 'vue';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import catalog from '../../format/catalog.json';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const el = ref(null);
const tables = Object.keys(catalog.tables);
// 시험용 쿼리 이력 (실제로는 접속 프로필별 파일)
const history = [
  'select * from mst_biz where use_yn = \'Y\'',
  'select biz_seq, biz_nm from mst_biz order by biz_seq',
  'update mst_wh set use_yn = \'N\' where wh_seq = ?',
];

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', ' '],
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
    const dot = before.match(/(\w+)\.$/);
    if (dot && catalog.tables[dot[1]]) {
      return { suggestions: Object.entries(catalog.tables[dot[1]].columns).map(([cn, c]) => ({
        label: cn, kind: monaco.languages.CompletionItemKind.Field, insertText: cn, detail: c.type, documentation: c.comment, range })) };
    }
    return { suggestions: tables.map(t => ({
      label: t, kind: monaco.languages.CompletionItemKind.Struct, insertText: t, detail: catalog.tables[t].comment, range })) };
  },
});

monaco.languages.registerInlineCompletionsProvider('sql', {
  provideInlineCompletions(model, position) {
    const typed = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
    if (!typed.trim()) return { items: [] };
    const hit = history.find(h => h.toLowerCase().startsWith(typed.toLowerCase()) && h.length > typed.length);
    return { items: hit ? [{ insertText: hit, range: { startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column } }] : [] };
  },
  disposeInlineCompletions() {},
});

onMounted(() => {
  window.__editor = monaco.editor.create(el.value, {
    value: '', language: 'sql', automaticLayout: true, inlineSuggest: { enabled: true }, fontSize: 14, minimap: { enabled: false },
  });
});
</script>

<template>
  <div ref="el" style="width:100vw;height:100vh"></div>
</template>
