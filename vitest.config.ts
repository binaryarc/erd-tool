import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // dev DB 를 쓰는 시험 파일끼리 겹치면 한쪽이 만든 시험용 테이블이 다른 쪽 리버스 결과에 섞인다
    fileParallelism: false,
  },
});
