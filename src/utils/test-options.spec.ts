import { parseTestOptions, setTestOptions, resetTestOptions, getTestMemberId } from './test-options';
import { today, ymd } from './date.util';

// 재현 전용 옵션을 쓰려면 비운영 NODE_ENV + 로컬 다날 URL + "이 DB 에 쓴다"는 명시적 확인(BILLING_TEST_DB_CONFIRM=host/db)이 모두 필요하다.
const LOCAL = {
  NODE_ENV: 'local',
  DANAL_API_BASE_URL: 'http://localhost:3999',
  DB_HOST: 'db.test',
  DB_NAME: 'ullo_test',
  BILLING_TEST_DB_CONFIRM: 'db.test/ullo_test',
};

describe('parseTestOptions — 재현 테스트 전용 CLI 옵션', () => {
  afterEach(() => resetTestOptions());

  it('옵션이 없으면 빈 객체를 돌려주고 환경 검사도 하지 않는다 (모든 잡)', () => {
    for (const job of ['billing', 'billing-retry', 'rolling', 'settlement']) {
      expect(parseTestOptions(job, [], { NODE_ENV: 'production' })).toEqual({});
    }
  });

  it('--as-of 와 --member 를 읽는다 (127.0.0.1 허용)', () => {
    const env = { ...LOCAL, DANAL_API_BASE_URL: 'http://127.0.0.1:3999' };
    expect(parseTestOptions('billing', ['--as-of', '2026-12-03', '--member', 'm1'], env)).toEqual({ asOf: '2026-12-03', memberId: 'm1' });
  });

  it('크레딧 만료 안내 잡(credit-expiry-notice)도 같은 안전장치 아래에서 --as-of/--member 를 허용한다', () => {
    expect(parseTestOptions('credit-expiry-notice', ['--as-of', '2026-12-03', '--member', 'm1'], LOCAL)).toEqual({ asOf: '2026-12-03', memberId: 'm1' });
    expect(() => parseTestOptions('credit-expiry-notice', ['--as-of', '2026-12-03'], { ...LOCAL, NODE_ENV: 'production' })).toThrow(/비운영/);
    expect(() => parseTestOptions('credit-expiry-notice', ['--as-of', '2026-12-03'], { ...LOCAL, BILLING_TEST_DB_CONFIRM: undefined })).toThrow(/BILLING_TEST_DB_CONFIRM/);
    expect(() => parseTestOptions('credit-expiry-notice', ['--bogus', 'x'], LOCAL)).toThrow(/알 수 없는 옵션/);
  });

  it('--as-of=값 형식도 읽고 billing-retry 도 허용한다', () => {
    expect(parseTestOptions('billing-retry', ['--as-of=2026-12-03'], LOCAL)).toEqual({ asOf: '2026-12-03' });
  });

  // N-8 재현 3 — 다른 잡에서 --as-of 가 today() 를 바꿔 수업 일정을 엉뚱한 시점으로 만들던 문제
  it.each(['rolling', 'settlement', 'holiday', 'member-purge', 'session-complete'])('%s 잡에서는 --as-of/--member 를 거부한다', (job) => {
    expect(() => parseTestOptions(job, ['--as-of', '2030-01-01'], LOCAL)).toThrow(/billing/);
    expect(() => parseTestOptions(job, ['--member', 'm1'], LOCAL)).toThrow(/billing/);
  });

  // N-8 재현 2 — 오타 옵션을 무시해 전체 회원이 대상이 되던 문제
  it.each([
    [['--as-of', '2027-03-02', '--memberr', 'm1']],
    [['--asof', '2027-03-02']],
    [['--as-of', '2027-03-02', '--force']],
    [['--as-of', '2027-03-02', 'extra']],
    [['m1']],
    [['--memberr=m1']],
  ])('알 수 없는 옵션·위치 인자 %j 는 거부한다', (args) => {
    expect(() => parseTestOptions('billing', args, LOCAL)).toThrow(/알 수 없는|옵션/);
  });

  it('옵션이 없는 잡에 알 수 없는 옵션만 있어도 거부한다 (오타를 조용히 무시하지 않는다)', () => {
    expect(() => parseTestOptions('rolling', ['--dry-run'], LOCAL)).toThrow(/알 수 없는|옵션/);
  });

  it.each([undefined, '', 'prod', 'production', 'PRODUCTION', 'staging', 'prodd'])(
    'NODE_ENV=%s 이면 거부한다 — 미주입도 운영으로 본다 (N-9 와 같은 기준)',
    (nodeEnv) => {
      expect(() => parseTestOptions('billing', ['--member', 'm1'], { ...LOCAL, NODE_ENV: nodeEnv })).toThrow(/운영|NODE_ENV/);
    },
  );

  it.each([undefined, '', 'https://one-api.danalpay.com', 'http://localhost.evil.com', 'not a url'])(
    'DANAL_API_BASE_URL=%s 이면 거부한다',
    (url) => {
      expect(() => parseTestOptions('billing', ['--as-of', '2026-12-03'], { ...LOCAL, DANAL_API_BASE_URL: url })).toThrow(/DANAL_API_BASE_URL/);
    },
  );

  // N-8: DB 대상 확인
  it.each([
    ['미설정', undefined],
    ['빈 값', ''],
    ['다른 DB 이름', 'db.test/ullo'],
    ['다른 호스트', 'prod-db/ullo_test'],
    ['DB 이름만', 'ullo_test'],
  ])('BILLING_TEST_DB_CONFIRM %s 이면 거부하고, 메시지에 확인해야 할 DB 를 알려 준다', (_name, confirm) => {
    expect(() => parseTestOptions('billing', ['--as-of', '2026-12-03'], { ...LOCAL, BILLING_TEST_DB_CONFIRM: confirm })).toThrow(
      /BILLING_TEST_DB_CONFIRM.*db\.test\/ullo_test/,
    );
  });

  it('DB 환경변수가 없으면 기본값(127.0.0.1/ullo)과 대조한다 — config 기본값과 같다', () => {
    const env = { NODE_ENV: 'local', DANAL_API_BASE_URL: 'http://localhost:3999', BILLING_TEST_DB_CONFIRM: '127.0.0.1/ullo' };
    expect(parseTestOptions('billing', ['--member', 'm1'], env)).toEqual({ memberId: 'm1' });
  });

  it.each(['2026-13-01', '2026-02-30', '20261203', 'abc', ''])('--as-of=%s 형식 오류를 거부한다', (v) => {
    expect(() => parseTestOptions('billing', ['--as-of', v], LOCAL)).toThrow(/--as-of/);
  });

  it('--member 값이 없으면 거부한다', () => {
    expect(() => parseTestOptions('billing', ['--member'], LOCAL)).toThrow(/--member/);
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
