// MD 템플릿 폴더 (설정 mdTemplateDir). 내보내기 탭, DB 비교 탭, AI 내보내기가 같이 쓴다.
import type { TemplateSet } from '../../shared/export/builtin-templates';

/** 설정한 폴더에서 읽은 템플릿. 폴더를 정하지 않았으면 undefined (내장만), 정한 폴더가 없으면 오류 */
export async function loadTemplates(): Promise<TemplateSet | undefined> {
  const s = await window.erd.settings.get();
  return s.mdTemplateDir ? window.erd.export.templates(s.mdTemplateDir) : undefined;
}
