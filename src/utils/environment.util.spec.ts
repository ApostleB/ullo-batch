import { isExplicitNonProduction } from './environment.util';

// 운영 판단 기준(N-9): NODE_ENV 가 명시적 비운영 값이 아니면 운영으로 본다 — 미주입·빈 값·오타 모두 운영 쪽(fail-closed).
describe('isExplicitNonProduction', () => {
  it.each(['local', 'development', 'dev', 'test', 'LOCAL', ' Development '])('%s → 비운영', (v) => {
    expect(isExplicitNonProduction(v)).toBe(true);
  });

  it.each([undefined, null, '', ' ', 'prod', 'production', 'PRODUCTION', 'staging', 'prodd', 'live'])('%s → 운영으로 본다', (v) => {
    expect(isExplicitNonProduction(v as string | undefined)).toBe(false);
  });
});
