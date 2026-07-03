# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # ts-node로 개발 실행 (nodemon: src 변경 시 자동 재시작)
npm run build        # TypeScript 컴파일 → dist/
npm run start        # 프로덕션 실행 (dist/index.js)
npm run job <key>    # 잡 수동 단건 실행 (DB 연결 → 1회 실행 → 종료)
```

**수동 잡 실행 키** (`src/cli.ts`의 `registry`):
```bash
npm run job rolling         # 반복 스케줄 롤링
npm run job settlement      # 정산 자동 생성
npm run job holiday         # 공휴일 동기화
npm run job billing         # 구독 정기결제 (스케줄러에서는 비활성)
npm run job billing-retry   # 구독 결제 재시도 (스케줄러에서는 비활성)
```

**PM2 배포:**
```bash
npm run deploy:local   # 빌드 + pm2 start (env local)
npm run deploy:prod    # 빌드 + pm2 start (env prod)
npm run pm2:reload     # 무중단 재시작
npm run pm2:logs       # 로그 확인
```

> 테스트/린트 도구는 설정되어 있지 않다. 검증은 `npm run build`(타입 체크) + `npm run job <key>`(단건 수동 실행)로 한다.
> PM2는 **반드시 단일 인스턴스**로 뜬다(`ecosystem.config.js`의 `instances: 1`) — 중복 결제/정산 방지.

## 아키텍처

### 기술 스택
- **ORM**: TypeORM (`AppDataSource` 싱글톤, `synchronize: false`)
- **스케줄러**: node-schedule
- **HTTP**: axios (토스 결제 / 공공데이터포털 API)
- **로깅**: winston (콘솔 + `logs/batch.log` + `logs/error.log`)
- **중복 실행 방지**: PostgreSQL Advisory Lock (`pg_try_advisory_lock(hashtext(jobName))`)
- **재시도**: p-retry

### 잡 실행 흐름

```
index.ts → AppDataSource.initialize() → scheduler/index.ts:startScheduler()
  → scheduler/common.ts:registerJob() — node-schedule 등록 (cron 무효 시 throw)
    → utils/run-job.ts:runJob() — Advisory Lock 획득 → p-retry 실행 → Lock 해제
      → jobs/*.job.ts:execute(log) — 실제 비즈니스 로직
```

`runJob()`은 Advisory Lock을 **단일 QueryRunner 커넥션**에서 유지한다(안전한 unlock 보장). Lock 획득 실패 = 이전 실행이 아직 진행 중이므로 잡을 스킵. 잡이 최종 실패해도 `runJob()` 내부에서 삼켜지고(에러 로깅) 프로세스는 죽지 않는다 — `run-job.ts:48`이 Slack 등 알림 연동 지점.

### 잡 목록

| 잡 (`JOB_NAME`) | cron 기본값 | retries | 설명 |
|---|---|---|---|
| `system-health-check` | `* * * * *` (매분) | 0 | 서비스 생존 확인 |
| `rolling-schedule` | `0 3 * * *` (매일 03:00) | 2 | 반복 시간표 → ClassSchedule 선행 생성 (`ROLLING_HORIZON_DAYS`일치) |
| `auto-settlement` | `0 4 1 * *` (매월 1일 04:00) | 2 | 전월 완료 세션 집계 → Settlement 생성 (멱등) |
| `holiday` | `0 2 1 * *` (매월 1일 02:00) | 3 | 공공데이터포털 특일정보 → Holiday upsert (`HOLIDAY_HORIZON_MONTHS`개월치) |
| `subscription-billing` | `0 21 * * *` | 0 | 구독 정기결제 — **스케줄러에서 주석 처리(비활성)** |
| `subscription-billing-retry` | `0 20 * * *` | 0 | 전일 실패(PAST_DUE) 재시도 — **비활성** |

billing 2종은 `scheduler/index.ts`에서 주석 처리되어 있으나 CLI(`npm run job billing`)로는 여전히 수동 실행 가능. 결제 잡은 건별로 try/catch·멱등 처리를 하므로 p-retry는 0.

### 새 잡 추가 방법

1. `src/jobs/새이름.job.ts` 작성 — `execute(log)` 함수와 `JOB_NAME` 상수 export
2. `src/config/index.ts`의 `jobs` 객체에 cron 항목 추가
3. `src/scheduler/index.ts`에 `registerJob()` 호출 추가
4. (선택) `src/cli.ts`의 `registry`에 수동 실행 키 추가

### DB 접근 패턴

- TypeORM Repository 방식: `AppDataSource.getRepository(MyEntity)`
- 트랜잭션: `AppDataSource.transaction(async (m) => ...)` 또는 QueryRunner 사용
- 엔티티는 **snake_case 컬럼명**, uuid 문자열 PK. `synchronize: false`이고 저장소에 마이그레이션이 없으므로 **엔티티 정의는 이미 존재하는 DB 스키마와 정확히 일치해야 한다** (스키마는 별도 관리). 새 엔티티는 `src/db/data-source.ts`의 `entities` 배열에도 등록.

### 반드시 알아야 할 공통 규칙

- **date 컬럼 UTC off-by-one**: TypeORM의 `date` 타입은 런타임에 `'YYYY-MM-DD'` 문자열로 온다. `new Date('YYYY-MM-DD')`는 UTC 자정으로 파싱되어 음수 오프셋(KST)에서 하루가 어긋난다. 날짜 비교/포맷 전에 반드시 `toLocalDate()`(문자열/Date 모두 로컬 자정으로 정규화)를 거칠 것. 이 규칙은 rolling-schedule·auto-settlement 전반에 걸쳐 있다.
- **멱등성**은 모든 쓰기 잡의 핵심 (재시도·중복 실행 대비):
  - 정산: `(studio_id, period_start)` 중복이면 스킵
  - 결제: `order_id = sub_{planId}_{YYYYMM}` + 토스 `Idempotency-Key`로 중복 청구 차단
  - 공휴일: `(locdate, seq)` 키로 insert/update/skip 분기
  - 롤링: 이미 존재하는 `scheduled_date`는 재생성 안 함(삭제분 포함 → 되살리지 않음)
- **롤링 요일 코드**: `ClassRepeatDay.day_of_week` 값이 `dowCode()`의 `SUN`..`SAT` 포맷과 다르면 매칭이 안 돼 조용히 0건 생성된다. rolling-schedule은 이 포맷 불일치를 감지해 `log.warn`으로 노출한다(`DOW_CODES` 검증).

### 주요 유틸

- `src/utils/date.util.ts`: `ymd()`, `parseLocalDate()`, `toLocalDate()`, `today()`, `addDays()`, `addMonthsClamped()`(월말 클램프 — 결제 앵커 유지), `toMinutes()`, `toTimeString()`, `dowCode()`, `DOW_CODES`
- `src/utils/run-job.ts`: 모든 잡의 실행 진입점 (Advisory Lock + 재시도 + 로깅)
- `src/utils/holiday-api.client.ts`: 공공데이터포털 `getHoliDeInfo` 호출. 결과 없는 달은 빈 배열로 정규화, `resultCode !== '00'`이면 throw
- `src/utils/toss-billing.client.ts`: 토스 빌링키 자동결제(`POST /v1/billing/{billingKey}`). 실패 시 `TossBillingError(code, message)` throw
- `src/logger/index.ts`: `logger` + `createJobLogger(job, runId)` (job/runId 태그 자동 부착)

### 환경변수 주요 항목

`.env`에서 로드(`dotenv`). 빈 문자열은 기본값으로 처리(`config/index.ts`의 `num()`).

| 변수 | 기본값 | 설명 |
|---|---|---|
| `NODE_ENV` | `local` | 실행 환경 |
| `DB_HOST/PORT/NAME/USERNAME/PASSWORD` | 127.0.0.1 / 5432 / ullo / ullo / '' | PostgreSQL 접속 정보 |
| `TOSS_SECRET_KEY` | '' | 토스페이먼츠 시크릿 키 (결제 잡) |
| `PUBLIC_DATA_API_KEY` | '' | 공공데이터포털 서비스키(디코딩 값, 공휴일 잡) |
| `LOG_LEVEL` / `LOG_DIR` | info / logs | 로그 레벨·디렉터리 |
| `JOB_*_CRON` | config 하드코딩 | 각 잡 cron (`JOB_ROLLING_SCHEDULE_CRON`, `JOB_AUTO_SETTLEMENT_CRON`, `JOB_HOLIDAY_CRON`, `JOB_BILLING_CRON`, `JOB_BILLING_RETRY_CRON`, `JOB_HEALTH_CHECK`) |
| `ROLLING_HORIZON_DAYS` | 30 | 스케줄 선행 생성 일수 |
| `HOLIDAY_HORIZON_MONTHS` | 3 | 공휴일 동기화 대상 개월 수(현재 월 포함) |
| `SETTLEMENT_DEFAULT_UNIT_PRICE` | 10000 | 정산 기본 단가 (정책 없을 때) |
| `SETTLEMENT_DEFAULT_COMMISSION_RATE` | 0.1 | 정산 기본 수수료율 (정책 없을 때) |

정산 단가/수수료율은 **스튜디오 정책 > 전역 정책 > env 기본값** 순으로 적용된다(`SettlementPolicy`).
