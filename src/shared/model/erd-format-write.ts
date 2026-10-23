// .erd 모델 파일 쓰기 (직렬화). 읽기는 erd-format-read.ts, 둘이 같이 쓰는 것은 erd-format-common.ts (erd-format.ts 에서 나눔, 2026-10-23)
// 같은 모델은 항상 같은 바이트로 저장한다: 테이블 이름순, 키 줄은 종류 후 이름순, 컬럼은 정의 순서, LF, 끝 줄바꿈 1개.

import { dialectOf, schemaOf } from '../dialect/names';
import { MODEL_VERSION, type Column, type ForeignKey, type FunctionDef, type SchemaModel, type Table } from './types';
import { COMMON_MARK, DOMAIN_MARK, FUNCTIONS_DIR, FUNCTION_HEAD, IDENTITY_WORD, INDEX_FILE, TABLES_FILE, cmp, defaultText, endsWithCommon, esc, identityArgs } from './erd-format-common';

// ---------- 쓰기 ----------

/**
 * 모델을 파일 이름 → 내용 으로 바꾼다. 테이블은 모두 tables.erd 한 파일에 이름순으로 쓴다. 테이블이 없으면 파일을 만들지 않는다.
 * (2026-10-16 사용자 지정: 전에는 접두어 그룹마다 mst.erd, whs.erd 처럼 나눠 썼다. 읽기는 폴더의 *.erd 를 모두 읽어 예전 폴더도 열린다)
 */
export function serializeModel(model: SchemaModel): Record<string, string> {
  const files: Record<string, string> = { [INDEX_FILE]: serializeIndex(model) };
  if (model.tables.length) {
    files[TABLES_FILE] = [...model.tables].sort((a, b) => cmp(a.name, b.name)).flatMap(t => tableLines(t, model.common)).join('\n') + '\n';
  }
  // 함수: 이름마다 파일 하나, 같은 이름(인자만 다름)은 인자 순으로 한 파일에
  const byName = new Map<string, FunctionDef[]>();
  for (const f of model.functions) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  for (const [name, defs] of byName) {
    files[`${FUNCTIONS_DIR}${name}.sql`] = defs.sort((a, b) => cmp(a.args, b.args))
      .map(f => `${FUNCTION_HEAD}${f.name}(${f.args})\n${f.definition}\n`).join('\n');
  }
  return files;
}

function serializeIndex(model: SchemaModel): string {
  const lines = [`erd-model ${MODEL_VERSION}`, `db ${dialectOf(model)} ${schemaOf(model)}`];
  for (const g of model.groups) {
    lines.push(['group', g.name, g.prefix ? `prefix=${g.prefix}` : '', g.isDefault ? 'default' : ''].filter(Boolean).join(' '));
  }
  for (const c of model.common) lines.push('common ' + columnText(c, false));
  for (const d of [...(model.domains ?? [])].sort((a, b) => cmp(a.name, b.name))) lines.push(`domain ${d.name} ${d.type}`);
  for (const s of [...model.sequences].sort((a, b) => cmp(a.name, b.name))) lines.push(`seq ${s.name} start=${s.start} inc=${s.inc}`);
  return lines.join('\n') + '\n';
}

function tableLines(t: Table, common: Column[]): string[] {
  const collapse = endsWithCommon(t.columns, common);
  const cols = collapse ? t.columns.slice(0, t.columns.length - common.length) : t.columns;
  const singlePk = t.pk.length === 1 ? t.pk[0] : undefined;
  const head = [t.name, '@' + t.id, esc(t.comment), collapse ? COMMON_MARK : ''].filter(Boolean).join(' ');
  return [
    head,
    ...cols.map(c => '  ' + columnText(c, c.name === singlePk)),
    ...(t.pk.length > 1 ? [`  PK (${t.pk.join(', ')})`] : []),
    ...[...t.fks].sort((a, b) => cmp(a.name, b.name))
      .map(f => `  FK ${f.name} (${f.columns.join(', ')}) > ${f.refTable}(${f.refColumns.join(', ')})${fkOptions(f)}`),
    ...[...t.uniques].sort((a, b) => cmp(a.name, b.name))
      .map(u => `  UQ ${u.name} (${u.columns.join(', ')})`),
    ...[...t.indexes].sort((a, b) => cmp(a.name, b.name))
      .map(i => `  IX ${i.name} (${i.columns.join(', ')})${i.unique ? ' UNIQUE' : ''}`),
    ...[...(t.checks ?? [])].sort((a, b) => cmp(a.name, b.name)).map(c => `  CK ${c.name} ${c.definition}`),
  ];
}

/**
 * FK 참조 동작과 DEFERRABLE 을 DDL 모양 그대로 (앞에 공백 하나). 기본값(NO ACTION, NOT DEFERRABLE)이면 빈 글자라 기존 모델 줄은 그대로다.
 * 모델 파일, 차이 설명, ALTER 가 같은 글자를 쓴다 (2026-10-16 추가: dev 의 FK 81개는 DEFERRABLE, test 는 아님)
 */
export function fkOptions(f: ForeignKey): string {
  return [
    f.onDelete ? ` ON DELETE ${f.onDelete.toUpperCase()}` : '',
    f.onUpdate ? ` ON UPDATE ${f.onUpdate.toUpperCase()}` : '',
    f.deferrable ? ` DEFERRABLE${f.deferrable === 'deferred' ? ' INITIALLY DEFERRED' : ''}` : '',
  ].join('');
}


export function columnText(c: Column, pk: boolean): string {
  const d = defaultText(c);
  return [
    c.name, c.type,
    c.domain ? DOMAIN_MARK + c.domain : '',
    pk ? 'PK' : '',
    c.notNull && !pk ? 'NN' : '',
    c.identity ? IDENTITY_WORD[c.identity] + identityArgs(c) : '',
    d !== undefined ? '=' + d : '',
    c.comment ? '#' + esc(c.comment) : '',
  ].filter(Boolean).join(' ');
}
