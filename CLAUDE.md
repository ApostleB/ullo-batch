# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # ts-node로 개발 실행 (파일 변경 시 자동 재시작)
npm run build        # TypeScript 컴파일 → dist/
npm run start        # 프로덕션 실행 (dist/index.js)
npm run job <key>    # 잡 수동 단건 실행
```

**수동 잡 실행 키:**
```bash
npm run job rolling      # 반복 스케줄 롤링
npm run job settlement   # 정산 자동 생성
```

**PM2 배포:**
```bash
npm run deploy:local   # 빌드 + pm2 start (local 환경)
npm run deploy:prod    # 빌드 + pm2 start (prod 환경)
npm run pm2:reload     # 무중단 재시작
npm run pm2:logs       # 로그 확인
```

## 아키텍처

### 기술 스택
- **ORM**: TypeORM (`AppDataSource` 싱글톤, `synchronize: false`)
- **스케줄러**: node-schedule
- **중복 실행 방지**: PostgreSQL Advisory Lock (`pg_try_advisory_lock(hashtext(jobName))`)
- **재시도**: p-retry

### 잡 실행 흐름

```
scheduler/index.ts
  → scheduler/common.ts: registerJob() — node-schedule 등록
    → utils/run-job.ts: runJob() — Advisory Lock 획득 → p-retry 실행 → Lock 해제
      → jobs/*.job.ts — 실제 비즈니스 로직
```

`runJob()`은 Advisory Lock을 단일 QueryRunner 커넥션에서 유지한다. Lock 획득 실패 시 잡을 스킵(이전 실행이 아직 진행 중).

### 잡 목록

| 잡 | cron 기본값 | 설명 |
|---|---|---|
| `system-health-check` | `* * * * *` (매분) | 서비스 생존 확인 |
| `rolling-schedule` | `0 3 * * *` (매일 03:00) | 반복 시간표 → ClassSchedule 선행 생성 (`ROLLING_HORIZON_DAYS`일치) |
| `auto-settlement` | `0 4 1 * *` (매월 1일 04:00) | 전월 완료 세션 집계 → Settlement 생성 (멱등) |
| `subscription-billing` | `0 21 * * *` | 구독 정기결제 — **현재 비활성화** |

### 새 잡 추가 방법

1. `src/jobs/새이름.job.ts` 작성 — `execute(log)` 함수와 `JOB_NAME` 상수 export
2. `src/config/index.ts`의 `jobs` 객체에 cron 항목 추가
3. `src/scheduler/index.ts`에 `registerJob()` 호출 추가
4. (선택) `src/cli.ts`의 `registry`에 수동 실행 키 추가

### DB 접근 패턴

TypeORM Repository 방식 사용:
```ts
const repo = AppDataSource.getRepository(MyEntity);
```

트랜잭션이 필요한 경우 `runner.manager.getRepository()`로 QueryRunner를 통해 처리.

### 주요 유틸

- `src/utils/date.util.ts`: `ymd()`, `today()`, `addDays()`, `addMonthsClamped()`, `dowCode()`, `toMinutes()`, `toTimeString()`
- `src/utils/run-job.ts`: 모든 잡의 실행 진입점. Advisory Lock + 로깅 + 재시도 포함.

### 환경변수 주요 항목

| 변수 | 설명 |
|---|---|
| `DB_HOST/PORT/NAME/USERNAME/PASSWORD` | PostgreSQL 접속 정보 |
| `JOB_*_CRON` | 각 잡의 cron 표현식 (기본값은 config에 하드코딩) |
| `ROLLING_HORIZON_DAYS` | 스케줄 선행 생성 일수 (기본 30) |
| `SETTLEMENT_DEFAULT_UNIT_PRICE` | 정산 기본 단가 (기본 10000) |
| `SETTLEMENT_DEFAULT_COMMISSION_RATE` | 정산 기본 수수료율 (기본 0.1) |
