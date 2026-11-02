# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # ts-node로 개발 실행 (nodemon: src 변경 시 자동 재시작)
npm run build        # TypeScript 컴파일 → dist/
npm test             # jest (TZ=Asia/Seoul 고정)
npm run start        # 프로덕션 실행 (dist/index.js)
npm run job <key>    # 잡 수동 단건 실행 (DB 연결 → 1회 실행 → 종료)
```

**수동 잡 실행 키** (`src/cli.ts`의 `registry`):
```bash
npm run job rolling         # 반복 스케줄 롤링
npm run job settlement      # 정산 자동 생성
npm run job holiday         # 공휴일 동기화
npm run job session-complete # 수업 종료 세션 완료 처리
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

> 린트 도구는 없다. 검증은 `npm run build`(타입 체크) + `npm test` + `npm run job <key>`(단건 수동 실행)로 한다.
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
| `session-complete` | `*/10 * * * *` (10분마다) | 1 | 수업 종료 처리 — ① `OPEN`→`STARTED`(시작시각 경과) ② 컷오프(종료시각, 미체크인 BOOKED 있으면 +1h 유예) 경과 수업 → `COMPLETED` + 세션 체크인→`COMPLETED`/미체크인→`NO_SHOW`. `HOLD`(PARTNER/ADMIN 세팅)는 skip. 설계: `docs/session-finalize-design.md` |
| `subscription-billing` | `0 21 * * *` | 0 | 구독 정기결제 — **스케줄러에서 주석 처리(비활성)** |
| `subscription-billing-retry` | `0 20 * * *` | 0 | 전일 실패(PAST_DUE) **1회** 재시도, 재시도도 실패하면 구독 해지 — **비활성** |

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

### 구독 청구 (다날) — `jobs/subscription-billing.job.ts` + `jobs/subscription-billing.danal.ts`

- **운영 게이트:** `DANAL_BILLING_BATCH_ENABLED` 가 정확히 `'true'` 일 때만 `executePrimary`/`executeRetry` 가 DB 를 조회하고 청구한다. 아니면 CLI 수동 실행(`npm run job billing`)도 아무것도 하지 않는다(기본 꺼짐). 스케줄러 등록은 계속 주석 처리 상태다. 다날 빌링 계약·빌링 테스트 키 확인 전에는 켜지 않는다(실연동 미검증).
- **상태 전이표**(백엔드 `SubscriptionChargeService`/`SubscriptionSettleService` 와 같다): 결제일 21:00 청구 성공 → `ACTIVE`, 다음 결제일 = **실제 청구일 + 1개월**(`nextChargeDateFrom`). 청구 실패(카드 거절·비활성 카드) → `PAST_DUE`(결제일 유지). 다음 날 20:00 재시도(1회) 성공 → `ACTIVE`(재시도일 + 1개월), **재시도도 실패 → 해지**(`CANCELED`, `is_active=N`, `next_charge_dt=NULL`; `SUSPENDED` 는 더 이상 만들지 않는다. 지급된 크레딧은 유지). 결과 불명 → 상태 불변·`CONFIRMING` 유지. 실패 전이는 **조건부 UPDATE**(`is_del=N`·`is_active=Y`·스냅샷 `status`) — 청구 도중 해지·비활성된 구독을 덮어쓰지 않는다. 기존 DB 의 `SUSPENDED` 행은 어느 잡도 조회하지 않고, `chargeDanalPlan` 에 넘어와도 오류 없이 건너뛴다.
- **실패 사유 코드(백엔드와 일치):** 화면 상태(결제실패/재시도대기)·사유 라벨은 백엔드가 `payment.status/fail_code` 에서 조회 시 계산한다. 배치는 `chargeDanalPlan` 의 `settle` 이 처리하지 못한 예기치 못한 예외가 새면 선점한 `CONFIRMING` 행에 `fail_code=BATCH_FAILED`(`fail_code IS NULL` 일 때만, 상태 `CONFIRMING` 유지, 예외는 그대로 던짐 — 운영자 표식·결과 불명 코드를 덮어쓰지 않는다)를 남긴다. 선점 전에 터진 예외는 결제 행이 없으므로 기록할 곳이 없고, 백엔드가 "결제일 경과 + 이번 주기 시도 없음" 을 `BATCH_NOT_RUN`(배치 미실행)으로 계산한다. 코드값·라벨·분류표는 `utils/subscription-fail-reason.util.ts`(백엔드 `subscription-display.util.ts` 복제, spec 표도 같다) — 한쪽을 바꾸면 함께 바꾼다.
- **구독 해지 알림(카카오 스텁):** 배치가 구독을 해지하는 모든 경로 — 재시도 실패(`RETRY_FAILED`, 비활성 카드 포함), 정지 회원(`MEMBER_SUSPENDED`), 이전 PG 카드·카드 없음(`OLD_PG_CARD`) — 에서 해지 UPDATE 와 같은 트랜잭션에서 `member_notification`(category=`KAKAO_STUB`, 앱 목록에 보이지 않음)에 기록한다(`utils/subscription-cancel-notice.util.ts`, 백엔드 `SubscriptionCancelNotifier` 의 사유 코드·문구 복제). 카카오 연동·실제 발송은 없다. 알림 insert 는 `manager.transaction`(SAVEPOINT)으로 감싸 실패해도 해지·결제 트랜잭션을 깨지 않고(`[NOTIFY_FAILED]` 로그만), 해지가 롤백되면 알림도 함께 사라진다. 1차 실패(`PAST_DUE`)·결과 불명·시스템 오류 취소는 해지가 아니라 알림이 없다. 크레딧 소멸 기한 같은 정책 문구는 넣지 않는다.
- **provider 분기**(`member_billing.provider`, 대소문자 무시): `DANAL` 만 청구한다. 그 외(INICIS·TOSS·NULL·알 수 없는 값)와 카드 정보가 없는 구독은 **결제일에 청구하지 않고 구독을 해지**한다(`cancelUnchargeablePlan` — 구독 행을 잠그고 조회 이후 바뀌지 않았을 때만, 결제 행·실패 기록 없음, 요약 로그 `해지 N건`). 결제일이 아직 오지 않았으면 건드리지 않는다(카드 교체 시간). 토스·이니시스 호출 경로는 없다.
- **정지 회원(안전장치):** 선점 트랜잭션에서 `member_suspension`(`released_at IS NULL AND (end_at IS NULL OR end_at > 지금)`)을 확인해 청구하지 않고 구독을 해지한다. 정지 서비스가 정지 시점에 구독을 해지하므로 이 경로는 안전장치다.
- **환불 진행 중:** 이 구독 결제에 `payment_cancel` `PENDING`/`UNKNOWN` 이 있으면 청구하지 않는다(`[CRITICAL]`, 어드민이 환불 건 해소 필요).
- **밀린 결제일(배치가 못 돈 날):** 다음 실행에서 지난 주기를 **한 번만** 청구하고(청구 없이 재설정하지 않는다 — 이전 `reanchor`/`nextChargeDateAfter` 제거) 다음 결제일은 실제 청구일 + 1개월이라 이틀 연속 청구가 없다. 주기 키는 `next_charge_dt` 의 월이므로 오래 밀린 주기도 그 달 키로 한 번만 청구된다. 이미 DONE 인 주기(T1)는 청구 없이 `paid_at + 1개월`(오늘 이후가 아니면 오늘 + 1개월)로 결제일만 옮긴다. 결제일이 아직 오지 않은 구독은 청구하지 않고, `CONFIRMING` 이 있는 주기는 어드민 해소가 먼저다. 어드민이 못 돈 구독을 수동 청구할 수 있다(백엔드 `retry-charge`, 같은 주기 키·락).
- **승인 후 재확인:** 지급 직전 구독을 다시 잠그고 해지·삭제·비활성·상태·결제일·카드·플랜·고정가가 바뀌었으면 보상 취소한다. 단 승인 도중 회원이 **새로 예약한 플랜 변경은 취소 사유가 아니며** 지급 후 보존한다(청구한 예약 그대로면 지운다).
- **순서:** 사전 검증 → `payment` 를 `CONFIRMING` 으로 선점(`pg_advisory_xact_lock(hashtext('subcycle:'||K))` 아래에서 주기 판정·삽입) → 트랜잭션 밖 `confirmBilling` → 응답 대조 → 지급 트랜잭션 → 실패 시 보상 `cancel(C)`. 다날 호출 전에 반드시 선점하고, 결과 불명(`DanalResultUnknownError`)은 같은 `orderId` 로 재호출하지 않는다(`CONFIRMING` 으로 남기면 어드민이 다날 관리자 화면 확인 후 해소). 동작표 T1~T13 은 백엔드 `SubscriptionChargeService`/`SubscriptionSettleService` 와 같다.
- **주기 키·시도 번호:** `utils/subscription-cycle.util.ts` 는 백엔드 `src/payment/subscription-cycle.util.ts` 의 복제다(spec 표도 같다). 주문번호는 `sub_{member_plan_id}_{YYYYMM}_{n}`(n=1..9). 한쪽을 바꾸면 반드시 함께 바꾼다.
- **금액:** `pending_plan_id` 가 있으면 새 플랜가·크레딧(판매 중인 `SUBSCRIPTION` 플랜일 때만 — 아니면 청구하지 않고 `[CRITICAL]`), 없으면 `locked_amount ?? plan.actual_amount`(크레딧도 `locked_credit` 규칙). 100원 미만이면 청구하지 않는다.
- **빌링키:** `enc:v1:` 형식만 청구한다(`BILLING_KEY_ENC_KEY` 없으면 건너뜀). 평문 빌링키·비밀키는 로그·예외에 남기지 않는다.
- **같은 주기에 `CONFIRM_MISMATCH_CANCELED`/`GRANT_FAILED_CANCELED` 인 `ABORTED` 행이 있으면** 매일 승인-취소가 반복되지 않도록 그 구독을 건너뛰고 `[CRITICAL]` 을 남긴다(어드민 수동 청구 `retry-charge` 로 해소 — `ACTIVE` 도 청구할 수 있다).
- **재현 테스트 옵션 `--as-of`/`--member` (N-8):** `billing`·`billing-retry` 잡에서만 허용하고, 알 수 없는 옵션·위치 인자는 거부한다. 그리고 `NODE_ENV` 가 명시적 비운영 값(`local`·`development`·`dev`·`test`)이고 `DANAL_API_BASE_URL` 이 localhost/127.0.0.1 이며 `BILLING_TEST_DB_CONFIRM=<DB_HOST>/<DB_NAME>`(이 프로세스가 연결할 DB)을 직접 적었을 때만 동작한다. 예: `NODE_ENV=local BILLING_TEST_DB_CONFIRM=127.0.0.1/ullo_test DANAL_API_BASE_URL=http://localhost:3999 npm run job billing -- --as-of 2027-03-02 --member <id>`.
- **운영 판단(N-9):** `NODE_ENV` 가 명시적 비운영 값이 아니면(미주입·오타·staging 포함) 운영으로 본다 — 게이트가 켜진 상태에서 `SK_TEST_` 키면 청구 전에 중단한다(`config.nodeEnv` = 원본 `NODE_ENV`, `config.env` 는 미주입 시 `local` 이라 쓰지 않는다). 개발 PC 는 `.env` 에 `NODE_ENV=local` 을 둔다.

### 반드시 알아야 할 공통 규칙

- **date 컬럼 UTC off-by-one**: TypeORM의 `date` 타입은 런타임에 `'YYYY-MM-DD'` 문자열로 온다. `new Date('YYYY-MM-DD')`는 UTC 자정으로 파싱되어 음수 오프셋(KST)에서 하루가 어긋난다. 날짜 비교/포맷 전에 반드시 `toLocalDate()`(문자열/Date 모두 로컬 자정으로 정규화)를 거칠 것. 이 규칙은 rolling-schedule·auto-settlement 전반에 걸쳐 있다.
- **멱등성**은 모든 쓰기 잡의 핵심 (재시도·중복 실행 대비):
  - 정산: `(studio_id, period_start)` 중복이면 스킵
  - 결제: 다날은 `order_id = sub_{planId}_{YYYYMM}_{n}` + `CONFIRMING` 선점(주기 락)으로 중복 청구 차단.
  - 공휴일: `(locdate, seq)` 키로 insert/update/skip 분기
  - 롤링: 이미 존재하는 `scheduled_date`는 재생성 안 함(삭제분 포함 → 되살리지 않음)
- **롤링 요일 코드**: `ClassRepeatDay.day_of_week` 값이 `dowCode()`의 `SUN`..`SAT` 포맷과 다르면 매칭이 안 돼 조용히 0건 생성된다. rolling-schedule은 이 포맷 불일치를 감지해 `log.warn`으로 노출한다(`DOW_CODES` 검증).

### 주요 유틸

- `src/utils/date.util.ts`: `ymd()`, `parseLocalDate()`, `toLocalDate()`, `today()`, `addDays()`, `addMonthsClamped()`(월말 클램프 — 결제 앵커 유지), `toMinutes()`, `toTimeString()`, `dowCode()`, `DOW_CODES`
- `src/utils/run-job.ts`: 모든 잡의 실행 진입점 (Advisory Lock + 재시도 + 로깅)
- `src/utils/holiday-api.client.ts`: 공공데이터포털 `getHoliDeInfo` 호출. 결과 없는 달은 빈 배열로 정규화, `resultCode !== '00'`이면 throw
- `src/utils/danal-billing.client.ts`: 다날 빌링 승인(`POST /billing/confirm`)·취소(`POST /payments/cancel`). 3분류 에러(`DanalApiError`=확실한 실패 / `DanalResultUnknownError`=결과 불명 / 설정 누락=일반 Error)
- `src/utils/subscription-fail-reason.util.ts`: 실패 사유 코드·라벨·`classifyPaymentFailure`(백엔드 복제), `BATCH_FAILED` 기록값
- `src/utils/subscription-cancel-notice.util.ts`: 구독 해지 알림 문구·`recordSubscriptionCancelNotice`(KAKAO_STUB 기록, 백엔드 복제)
- `src/utils/subscription-cycle.util.ts`: 주기 키·시도 번호·`classifyCycle`·다음 결제일 규칙(`nextChargeDateFrom`: 실제 청구일 + 1개월) (백엔드 복제)
- `src/utils/environment.util.ts`: `isExplicitNonProduction` — 운영 판단 기준(N-9)
- `src/utils/test-options.ts`: 재현 전용 CLI 옵션 검증(N-8)
- `src/utils/toss-billing.client.ts`: 토스 빌링키 자동결제 클라이언트. **구독 청구 잡은 더 이상 호출하지 않는다**(PG 전환 원칙) — 사용처가 없다
- `src/logger/index.ts`: `logger` + `createJobLogger(job, runId)` (job/runId 태그 자동 부착)

### 환경변수 주요 항목

`.env`에서 로드(`dotenv`). 빈 문자열은 기본값으로 처리(`config/index.ts`의 `num()`).

| 변수 | 기본값 | 설명 |
|---|---|---|
| `NODE_ENV` | (미주입) | 실행 환경. `local`·`development`·`dev`·`test` 만 비운영, 그 외·미주입은 운영으로 본다(테스트 키 방어, 재현 옵션). `config.env` 는 미주입 시 `local` |
| `BILLING_TEST_DB_CONFIRM` | (없음) | 재현 옵션(`--as-of`/`--member`) 전용: `DB_HOST/DB_NAME` 과 정확히 같아야 한다 |
| `DB_HOST/PORT/NAME/USERNAME/PASSWORD` | 127.0.0.1 / 5432 / ullo / ullo / '' | PostgreSQL 접속 정보 |
| `TOSS_SECRET_KEY` | '' | (미사용) 구독 청구 잡이 토스를 호출하지 않는다 |
| `DANAL_BILLING_BATCH_ENABLED` | 꺼짐 | 구독 청구 게이트 (정확히 `true` 일 때만 청구) |
| `DANAL_SECRET_KEY` / `DANAL_MERCHANT_ID` | '' | 다날 서버 호출 (백엔드와 같은 이름. 배치는 `DANAL_CLIENT_KEY` 불필요) |
| `DANAL_API_BASE_URL` | https://one-api.danalpay.com | 다날 API 주소 |
| `BILLING_KEY_ENC_KEY` | '' | member_billing.billing_key 복호화 키 (백엔드와 동일) |
| `PUBLIC_DATA_API_KEY` | '' | 공공데이터포털 서비스키(디코딩 값, 공휴일 잡) |
| `LOG_LEVEL` / `LOG_DIR` | info / logs | 로그 레벨·디렉터리 |
| `JOB_*_CRON` | config 하드코딩 | 각 잡 cron (`JOB_ROLLING_SCHEDULE_CRON`, `JOB_AUTO_SETTLEMENT_CRON`, `JOB_HOLIDAY_CRON`, `JOB_BILLING_CRON`, `JOB_BILLING_RETRY_CRON`, `JOB_HEALTH_CHECK`) |
| `ROLLING_HORIZON_DAYS` | 30 | 스케줄 선행 생성 일수 |
| `HOLIDAY_HORIZON_MONTHS` | 3 | 공휴일 동기화 대상 개월 수(현재 월 포함) |
| `SETTLEMENT_DEFAULT_UNIT_PRICE` | 10000 | 정산 기본 단가 (정책 없을 때) |
| `SETTLEMENT_DEFAULT_COMMISSION_RATE` | 0.1 | 정산 기본 수수료율 (정책 없을 때) |

정산 단가/수수료율은 **스튜디오 정책 > 전역 정책 > env 기본값** 순으로 적용된다(`SettlementPolicy`).
