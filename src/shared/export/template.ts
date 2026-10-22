// MD 템플릿 채우기 (STEP 7, 설계 8-1: 형식은 템플릿 파일에 두고 코드에 박지 않는다).
// 문법은 두 가지뿐이다.
//   {{이름}}                값 넣기. 현재 반복 항목에서 찾고, 없으면 바깥에서 찾는다
//   {{#이름}} ... {{/이름}}  배열이면 항목마다 반복, 참거짓이면 참일 때만, 빈 배열이나 빈 값이면 생략
// 블록 표시만 있는 줄은 줄째 지워 표 사이에 빈 줄이 생기지 않게 한다.
// 한 번 훑으며 바꾸므로 넣은 값 안의 {{...}} 는 다시 바꾸지 않는다. 없는 값은 템플릿 이름과 줄 번호로 알린다(사용자 템플릿, 2026-10-22).

type Scope = Record<string, unknown>;

/** 블록 또는 값 하나. 블록: 1 이름, 2 안쪽. 값: 3 이름 */
const TOKEN = /\{\{#(\w+)\}\}(\n?)([\s\S]*?)\{\{\/\1\}\}\n?|\{\{(\w+)\}\}/g;

interface Source { text: string; name: string }

const lineAt = (src: Source, at: number) => src.text.slice(0, at).split('\n').length;

function lookup(scopes: Scope[], key: string, src: Source, at: number): unknown {
  for (let i = scopes.length - 1; i >= 0; i--) if (key in scopes[i]) return scopes[i][key];
  throw new Error(`${src.name ? `${src.name} ` : ''}${lineAt(src, at)}째 줄: 템플릿 값 ${key} 이(가) 없습니다`);
}

/** tpl 은 src.text 의 base 위치부터의 조각 */
function render(tpl: string, scopes: Scope[], src: Source, base: number): string {
  return tpl.replace(TOKEN, (m: string, block: string | undefined, nl: string, inner: string, key: string | undefined, off: number) => {
    const at = base + off;
    if (key) return String(lookup(scopes, key, src, at) ?? '');
    const v = lookup(scopes, block!, src, at);
    const innerAt = at + `{{#${block}}}`.length + nl.length;
    if (Array.isArray(v)) return v.map(item => render(inner, [...scopes, item as Scope], src, innerAt)).join('');
    return v ? render(inner, scopes, src, innerAt) : '';
  });
}

/** name: 오류에 보일 템플릿 이름 (예: group-tables.md) */
export function fillTemplate(tpl: string, data: Scope, name = ''): string {
  const text = tpl.replace(/\r\n/g, '\n');
  return render(text, [data], { text, name }, 0);
}

/** 표 칸에 넣을 글자: | 는 \| 로, 줄바꿈은 공백으로 */
export const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
