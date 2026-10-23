// .erd 모델 파일 표기. 쓰기, 읽기, 공용 도구를 파일 셋으로 나눴고(2026-10-23) 가져다 쓰는 쪽은 이 경로를 그대로 쓴다.
// 쓰기: erd-format-write.ts, 읽기: erd-format-read.ts, 둘이 같이 쓰는 것: erd-format-common.ts

export { INDEX_FILE, FUNCTIONS_DIR, TABLES_FILE, identityArgs, endsWithCommon, sameColumn, groupOf } from './erd-format-common';
export { serializeModel, fkOptions, columnText } from './erd-format-write';
export { parseModel, parseColumn } from './erd-format-read';
export type { ParseResult } from './erd-format-read';
