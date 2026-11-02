import { buildCreditExpiryMessage, creditExpiryLink, daysBetween } from './credit-expiry-notice.util';

describe('크레딧 만료 사전 안내 문구', () => {
  it('남은 크레딧 수와 만료일, 남은 일수를 넣는다', () => {
    const m = buildCreditExpiryMessage({ remaining: 7, endYmd: '2026-12-03', daysLeft: 15 });
    expect(m.title).toBe('크레딧 만료가 다가왔어요');
    expect(m.body).toBe('구독 해지 후 남은 크레딧 7개가 2026-12-03에 만료돼요(15일 남음). 만료 전에 이용해 주세요.');
  });

  it('금액·키 같은 민감값이나 정책 문구(환불·소멸 기한 규칙)가 없다', () => {
    const m = buildCreditExpiryMessage({ remaining: 1, endYmd: '2026-12-03', daysLeft: 1 });
    expect(`${m.title} ${m.body}`).not.toMatch(/원|결제|키|환불|해지 후 15일/);
  });

  it('멱등 키(link)는 만료일 묶음 단위다', () => {
    expect(creditExpiryLink('2026-12-03')).toBe('credit-expiry?end_dt=2026-12-03');
  });

  it('daysBetween 은 로컬 날짜 차이(월·연 경계 포함)', () => {
    expect(daysBetween('2026-11-18', '2026-12-03')).toBe(15);
    expect(daysBetween('2026-12-20', '2027-01-04')).toBe(15);
    expect(daysBetween('2026-11-03', '2026-11-04')).toBe(1);
  });
});
