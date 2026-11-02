import { parseTestOptions, setTestOptions, resetTestOptions, getTestMemberId } from './test-options';
import { today, ymd } from './date.util';

const LOCAL = { NODE_ENV: 'local', DANAL_API_BASE_URL: 'http://localhost:3999' };

describe('parseTestOptions — 재현 테스트 전용 CLI 옵션', () => {
  afterEach(() => resetTestOptions());

  it('옵션이 없으면 빈 객체를 돌려주고 환경 검사도 하지 않는다', () => {
    expect(parseTestOptions(['node', 'cli', 'billing'], { NODE_ENV: 'production' })).toEqual({});
  });

  it('--as-of 와 --member 를 읽는다 (127.0.0.1 허용)', () => {
    const env = { NODE_ENV: 'local', DANAL_API_BASE_URL: 'http://127.0.0.1:3999' };
    expect(parseTestOptions(['node', 'cli', 'billing', '--as-of', '2026-12-03', '--member', 'm1'], env)).toEqual({
      asOf: '2026-12-03',
      memberId: 'm1',
    });
  });

  it('--as-of=값 형식도 읽는다', () => {
    expect(parseTestOptions(['node', 'cli', 'billing', '--as-of=2026-12-03'], LOCAL)).toEqual({ asOf: '2026-12-03' });
  });

  it.each(['production', 'prod', 'PRODUCTION'])('NODE_ENV=%s 이면 거부한다', (nodeEnv) => {
    expect(() => parseTestOptions(['n', 'c', 'billing', '--member', 'm1'], { ...LOCAL, NODE_ENV: nodeEnv })).toThrow(/운영|production/i);
  });

  it.each([undefined, '', 'https://one-api.danalpay.com', 'http://localhost.evil.com', 'not a url'])(
    'DANAL_API_BASE_URL=%s 이면 거부한다',
    (url) => {
      expect(() => parseTestOptions(['n', 'c', 'billing', '--as-of', '2026-12-03'], { NODE_ENV: 'local', DANAL_API_BASE_URL: url })).toThrow(
        /DANAL_API_BASE_URL/,
      );
    },
  );

  it.each(['2026-13-01', '2026-02-30', '20261203', 'abc', ''])('--as-of=%s 형식 오류를 거부한다', (v) => {
    expect(() => parseTestOptions(['n', 'c', 'billing', '--as-of', v], LOCAL)).toThrow(/--as-of/);
  });

  it('--member 값이 없으면 거부한다', () => {
    expect(() => parseTestOptions(['n', 'c', 'billing', '--member'], LOCAL)).toThrow(/--member/);
  });

  it('setTestOptions 후 today() 가 as-of 날짜(로컬 자정)를 돌려주고 reset 하면 원복된다', () => {
    const real = ymd(today());
    setTestOptions({ asOf: '2027-01-03', memberId: 'm1' });
    expect(ymd(today())).toBe('2027-01-03');
    expect(getTestMemberId()).toBe('m1');
    resetTestOptions();
    expect(ymd(today())).toBe(real);
    expect(getTestMemberId()).toBeUndefined();
  });
});
