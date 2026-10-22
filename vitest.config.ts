import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // DB 시험의 BE 폴더 등 이 PC 전용 값을 test/.env.local 에서 읽는다 (git 에 올리지 않음)
    setupFiles: ['test/helpers/load-env.ts'],
    environment: 'node',
    // dev DB 를 쓰는 시험 파일끼리 겹치면 한쪽이 만든 시험용 테이블이 다른 쪽 리버스 결과에 섞인다
    fileParallelism: false,
  },
});
