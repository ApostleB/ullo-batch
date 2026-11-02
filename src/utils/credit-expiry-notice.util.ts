import { parseLocalDate } from './date.util';

/**
 * 크레딧 만료 사전 안내 문구·멱등 키. 해지된 구독에서 지급된 크레딧은 유효기간까지 유지되고(해지 후 소멸 없음),
 * 만료 15일 전에 안내만 한다. 금액·키 등 민감값은 넣지 않는다.
 */

interface Message {
  title: string;
  body: string;
}

export function buildCreditExpiryMessage(input: { remaining: number; endYmd: string; daysLeft: number }): Message {
  return {
    title: '크레딧 만료가 다가왔어요',
    body: `구독 해지 후 남은 크레딧 ${input.remaining}개가 ${input.endYmd}에 만료돼요(${input.daysLeft}일 남음). 만료 전에 이용해 주세요.`,
  };
}

/**
 * 멱등 키 — member_notification.link. 같은 회원·같은 만료일 묶음에 한 번만 기록한다(회원은 member_id 컬럼이 맡는다).
 * 기존 컬럼만 쓰므로 스키마 변경이 없다.
 */
export function creditExpiryLink(endYmd: string): string {
  return `credit-expiry?end_dt=${endYmd}`;
}

/** 'YYYY-MM-DD' 두 날짜의 일수 차이(to - from). 로컬 자정 기준이라 DST·UTC 오프셋에 흔들리지 않는다 */
export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((parseLocalDate(toYmd).getTime() - parseLocalDate(fromYmd).getTime()) / 86_400_000);
}
