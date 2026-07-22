# 수업 종료 처리 배치 설계 (session-complete)

> 대상: `ullo-batch` — 기존 잡 `session-complete`에 통합 구현 (`src/jobs/session-complete.job.ts`)
> 작성일: 2026-07-23
> 상태: **구현 완료 — 롤백 트랜잭션으로 4개 시나리오(즉시마감/유예/강제마감 NO_SHOW/HOLD skip) 검증 완료**

## 목적

종료 시각이 지난 수업(스케줄)을 자동으로 마감한다. 미체크인(잠재 노쇼) 멤버가 있으면 1시간 유예 후 마감하고, 멤버 세션은 체크인 여부에 따라 `COMPLETED`/`NO_SHOW`로 확정한다.

## 상태머신

### ① 수업 — `studio_class_schedule.status`
```
OPEN ──(시작시각 경과)──▶ STARTED ──(종료 처리)──▶ COMPLETED
                                 ▲
     HOLD ─(PARTNER/ADMIN이 세팅 · 배치는 skip)
```
- 신규 값 `STARTED`, `COMPLETED` 추가 (현재 DB에는 `OPEN`만 존재. `status`는 text라 마이그레이션 불필요하나 **ullo-api·ullo-admin·ullo-partner-front와 공유되는 계약**).
- `HOLD`는 PARTNER/ADMIN이 세팅. 배치는 생성하지 않고 **존중(skip)만** 한다.

### ② 멤버 세션 — `member_class_session.session_status`
```
BOOKED ─┬─ checked_in_at 있음 ──▶ COMPLETED
        └─ checked_in_at 없음 ──▶ NO_SHOW
```
- 종료 처리 시점에 확정. `CANCELLED`는 대상 아님.
- 크레딧은 **예약 시 이미 차감**되므로 종료/노쇼 처리에서 크레딧을 건드리지 않는다(이중 차감 방지). NO_SHOW 환불도 하지 않음.

## 배치 동작

매 N분 실행. 대상: `status NOT IN ('HOLD', 'COMPLETED')` 스케줄.

| 단계 | 조건 | 동작 |
|---|---|---|
| **A. 시작 처리** | 시작시각(`scheduled_date + start_time`) 경과 & `status='OPEN'` | `OPEN → STARTED` |
| **B. 종료 판정** | 미체크인 BOOKED 멤버 **없음** & 종료시각 경과 | 즉시 종료 처리 |
| | 미체크인 BOOKED 멤버 **있음** & 종료+1h **미경과** | 보류 (이번 회차 skip) |
| | 미체크인 BOOKED 멤버 **있음** & 종료+1h **경과** | 강제 종료 처리 |
| **종료 처리** | (B 충족) | ① 세션 `BOOKED`: 체크인→`COMPLETED` / 미체크인→`NO_SHOW`  ② 수업 `status → COMPLETED` |
| **HOLD 예외** | `status='HOLD'` | 전 단계 skip |

- 종료 시각 = `scheduled_date + COALESCE(end_time, '23:59:59')`
- 시각 비교 기준 = `LOCALTIMESTAMP` (DB 서버 로컬시각, KST 전제. date/time 컬럼과 timezone 없이 동일 기준)
- 유예 컷오프: 전원 체크인이면 `종료시각`, 미체크인 있으면 `종료시각 + 1h`
- 멱등: 이미 `COMPLETED`/`HOLD`면 대상에서 제외되므로 재실행 안전

## 스케줄링
- cron 기본값 `*/10 * * * *` (10분마다), `JOB_SESSION_FINALIZE_CRON`로 조정
- 기존 `runJob` 래퍼(Advisory Lock + 재시도) 사용

## 전제 조건 (선행 의존성)

**체크인 파이프라인**: 현재 `member_class_session.checked_in_at`은 전 건 null이다. 체크인을 기록하는 기능(ullo-api)이 **선행되지 않으면**, 모든 수업이 "미체크인 있음"으로 판정 → 항상 1시간 유예 후 전원 `NO_SHOW`가 된다. 이 배치는 체크인 기록이 실제로 쌓인다는 전제에서만 올바르게 동작한다.

## 구현 시 유의 (이미 확인된 사항)

- `AppDataSource.query()`는 UPDATE에서 `[rows, affected]` 튜플을 반환 → 변경 건수는 `QueryRunner.query(sql, params, true)`의 `affected`로 집계.
- 한 스케줄에 멤버 세션 N건 → "미체크인 있음" 판정은 스케줄 단위 `EXISTS` 서브쿼리로.

## 미해결/후속
- 시작 처리(A)와 종료 처리(B)를 **한 잡**에서 두 UPDATE로 처리할지, 잡을 분리할지 → 한 잡 권장.
- `STARTED`/`COMPLETED`/`HOLD` 상태값을 ullo-api·admin·partner-front와 최종 합의 필요.
