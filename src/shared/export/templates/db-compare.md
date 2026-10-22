# DB 비교 결과

- 왼쪽 (지금 모습): {{fromLabel}}
- 오른쪽 (바꿀 모습): {{toLabel}}
- 비교 시각: {{generatedAt}}
- 차이 {{total}}개, 위험 {{dangers}}개
{{#filter}}
- 좁힌 조건: {{filter}} (보이는 줄만 담고 ALTER 는 뺌)
{{/filter}}

{{#same}}
두 쪽이 같습니다.
{{/same}}
{{#hasItems}}
## 1. 요약

| No. | 종류 | 추가 | 삭제 | 변경 | 이름 바꿈 |
|---|---|---|---|---|---|
{{#summary}}
| {{no}} | {{kind}} | {{add}} | {{drop}} | {{alter}} | {{rename}} |
{{/summary}}

## 2. 차이 목록

| No. | 종류 | 변화 | 테이블 | 대상 | 내용 | 위험 |
|---|---|---|---|---|---|---|
{{#items}}
| {{no}} | {{kind}} | {{change}} | {{table}} | {{name}} | {{detail}} | {{danger}} |
{{/items}}
{{/hasItems}}
{{#alter}}

## 3. 왼쪽을 오른쪽처럼 바꾸는 ALTER (참고용, 실행하지 않았음)

```sql
{{alter}}
```
{{/alter}}
