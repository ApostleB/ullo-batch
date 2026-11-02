export enum IsYn {
  Y = 'Y',
  N = 'N',
}

export enum ActiveStatus {
  Y = 'Y',
  N = 'N',
}

/** member_class_session.session_status */
export const SessionStatus = {
  BOOKED: 'BOOKED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
  NO_SHOW: 'NO_SHOW',
} as const;

/** studio_class_schedule.status (수업 상태머신: OPEN → STARTED → COMPLETED, HOLD는 PARTNER/ADMIN 세팅) */
export const ScheduleStatus = {
  OPEN: 'OPEN',
  STARTED: 'STARTED',
  HOLD: 'HOLD',
  COMPLETED: 'COMPLETED',
} as const;

/** settlement.status */
export const SettlementStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
} as const;

/** payment.status */
export const PaymentStatus = {
  READY: 'READY',
  DONE: 'DONE',
  ABORTED: 'ABORTED',
  CANCELED: 'CANCELED',
  /** 다날 승인 진행 중 또는 결과 불명 — fail_code 로 구분(null=진행 중). 결과 불명은 어드민이 해소한다 */
  CONFIRMING: 'CONFIRMING',
} as const;

/** member_plan.status (구독 상태머신) */
export const PlanStatus = {
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  SUSPENDED: 'SUSPENDED',
  CANCELED: 'CANCELED',
} as const;
