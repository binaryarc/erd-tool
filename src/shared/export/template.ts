// MD 템플릿 채우기 (STEP 7, 설계 8-1: 형식은 템플릿 파일에 두고 코드에 박지 않는다).
// 문법은 두 가지뿐이다.
//   {{이름}}                값 넣기. 현재 반복 항목에서 찾고, 없으면 바깥에서 찾는다
//   {{#이름}} ... {{/이름}}  배열이면 항목마다 반복, 참거짓이면 참일 때만, 빈 배열이나 빈 값이면 생략
// 블록 표시만 있는 줄은 줄째 지워 표 사이에 빈 줄이 생기지 않게 한다.

type Scope = Record<string, unknown>;

const lookup = (scopes: Scope[], key: string): unknown => {
  for (let i = scopes.length - 1; i >= 0; i--) if (key in scopes[i]) return scopes[i][key];
  throw new Error(`템플릿 값 ${key} 이(가) 없습니다`);
};

const BLOCK = /\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g;

function render(tpl: string, scopes: Scope[]): string {
  const expanded = tpl.replace(BLOCK, (_m, key: string, inner: string) => {
    const v = lookup(scopes, key);
    if (Array.isArray(v)) return v.map(item => render(inner, [...scopes, item as Scope])).join('');
    return v ? render(inner, scopes) : '';
  });
  return expanded.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => String(lookup(scopes, key) ?? ''));
}

export function fillTemplate(tpl: string, data: Scope): string {
  return render(tpl.replace(/\r\n/g, '\n'), [data]);
}

/** 표 칸에 넣을 글자: | 는 \| 로, 줄바꿈은 공백으로 */
export const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
