// DB 비교 결과 → MD (2026-10-22 사용자 요청). 형식은 templates/db-compare.md 에 있고 여기서는 값만 만든다.
// 화면의 「MD 저장」, 「복사」 가 같이 쓴다. 화면에서 종류나 위험만 보기로 좁혔으면 보이는 줄만 담고 머리에 적는다.

import { cell, fillTemplate } from './template';
import { templateOf, type TemplateSet } from './builtin-templates';
import { stamp } from './flyway';
import { DIFF_CHANGE_LABEL, DIFF_KIND_LABEL, summarize, type DiffItem, type DiffKind } from '../model/diff';

export interface CompareMdInput {
  items: DiffItem[];
  fromLabel: string;
  toLabel: string;
  now: Date;
  /** 왼쪽을 오른쪽처럼 바꾸는 ALTER. 없으면 그 절을 뺀다 */
  alter?: string;
  /** 화면에서 좁힌 조건 (예: 「컬럼, 위험」). 전체를 담으면 비운다 */
  filter?: string;
  /** 템플릿 폴더에서 읽은 것 (없으면 내장) */
  templates?: TemplateSet;
}

const pad = (n: number) => String(n).padStart(2, '0');
const at = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function buildCompareMd(i: CompareMdInput): string {
  const sum = Object.entries(summarize(i.items)).filter(([, v]) => v.add + v.drop + v.alter + v.rename);
  return fillTemplate(templateOf(i.templates, 'db-compare.md'), {
    fromLabel: cell(i.fromLabel), toLabel: cell(i.toLabel), generatedAt: at(i.now),
    total: i.items.length, dangers: i.items.filter(x => x.danger).length, filter: i.filter ?? '',
    same: !i.items.length, hasItems: i.items.length > 0,
    summary: sum.map(([k, v], n) => ({ no: n + 1, kind: DIFF_KIND_LABEL[k as DiffKind], ...v })),
    items: i.items.map((d, n) => ({
      no: n + 1, kind: DIFF_KIND_LABEL[d.kind], change: DIFF_CHANGE_LABEL[d.change],
      table: cell(d.table), name: cell(d.name), detail: cell(d.detail), danger: cell(d.danger),
    })),
    alter: i.items.length ? (i.alter ?? '').trimEnd() : '',
  }, 'db-compare.md');
}

/** 저장 파일 이름: db-compare_{왼쪽}_{오른쪽}_{시각}.md. 이름에 못 쓰는 글자는 _ 로 */
export const compareMdName = (fromLabel: string, toLabel: string, now: Date) => {
  const slug = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';
  return `db-compare_${slug(fromLabel)}_${slug(toLabel)}_${stamp(now)}.md`;
};
