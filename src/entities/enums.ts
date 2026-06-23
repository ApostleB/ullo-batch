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
} as const;

/** member_plan.status (구독 상태머신) */
export const PlanStatus = {
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  SUSPENDED: 'SUSPENDED',
  CANCELED: 'CANCELED',
} as const;
