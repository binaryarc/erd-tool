// PostgreSQL 이 돌려주는 긴 타입 이름을 같은 뜻의 짧은 이름으로 바꾼다 (정보 손실 없음)

const TYPE_ALIASES: [RegExp, string][] = [
  [/^character varying/, 'varchar'],
  [/^character\b/, 'char'],
  [/^timestamp without time zone/, 'timestamp'],
  [/^timestamp with time zone/, 'timestamptz'],
  [/^time without time zone/, 'time'],
  [/^time with time zone/, 'timetz'],
];

export const shortType = (t: string): string => TYPE_ALIASES.reduce((s, [re, to]) => s.replace(re, to), t);
