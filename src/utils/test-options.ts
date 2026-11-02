import { isExplicitNonProduction } from './environment.util';
import { parseLocalDate, setAsOfDate } from './date.util';

/**
 * 재현 테스트 전용 CLI 옵션 (`npm run job billing -- --as-of YYYY-MM-DD --member <id>`).
 * 스케줄러 경로(index.ts)는 이 모듈을 호출하지 않으므로 옵션이 켜질 수 없다.
 *
 * 안전장치 (N-8) — 하나라도 어긋나면 DB 연결 전에 거부한다:
 *  1. billing / billing-retry / credit-expiry-notice 잡에서만 허용한다 (다른 잡의 today() 를 바꾸지 못하게).
 *  2. 알 수 없는 옵션·위치 인자는 거부한다 (오타가 조용히 무시되어 전체 회원이 대상이 되지 않게).
 *  3. NODE_ENV 가 명시적 비운영 값(local·development·dev·test)이어야 한다 — 미주입은 운영으로 본다 (N-9 와 같은 기준).
 *  4. DANAL_API_BASE_URL 이 localhost/127.0.0.1 이어야 한다 (실제 다날로 나가지 않게).
 *  5. BILLING_TEST_DB_CONFIRM 이 이 프로세스가 연결할 DB(`DB_HOST/DB_NAME`)와 정확히 같아야 한다 — 운영 .env 가 있는 서버 셸에서
 *     실수로 운영 DB 에 재현 옵션을 쓰지 않도록, 대상 DB 를 사람이 직접 적어야 한다.
 */
export interface TestOptions {
  asOf?: string;
  memberId?: string;
}

export interface TestOptionsEnv {
  NODE_ENV?: string;
  DANAL_API_BASE_URL?: string;
  DB_HOST?: string;
  DB_NAME?: string;
  BILLING_TEST_DB_CONFIRM?: string;
}

/** 재현 옵션을 쓸 수 있는 잡 */
const TEST_OPTION_JOBS: readonly string[] = ['billing', 'billing-retry', 'credit-expiry-notice'];
const KNOWN_OPTIONS = ['as-of', 'member'] as const;
/** config.db 의 기본값과 같다 */
const DEFAULT_DB_HOST = '127.0.0.1';
const DEFAULT_DB_NAME = 'ullo';

let memberId: string | undefined;

export function getTestMemberId(): string | undefined {
  return memberId;
}

export function setTestOptions(opts: TestOptions): void {
  setAsOfDate(opts.asOf ? parseLocalDate(opts.asOf) : null);
  memberId = opts.memberId;
}

export function resetTestOptions(): void {
  setTestOptions({});
}

function validYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseLocalDate(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` === s;
}

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1';
  } catch {
    return false;
  }
}

/** `--name value` / `--name=value` 만 허용한다. 알 수 없는 옵션·위치 인자는 던진다. */
function readOptions(args: string[]): Partial<Record<(typeof KNOWN_OPTIONS)[number], string>> {
  const found: Partial<Record<(typeof KNOWN_OPTIONS)[number], string>> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) throw new Error(`알 수 없는 인자: ${a} (옵션은 --as-of, --member 만 있습니다.)`);
    const eq = a.indexOf('=');
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)) as (typeof KNOWN_OPTIONS)[number];
    if (!KNOWN_OPTIONS.includes(name)) throw new Error(`알 수 없는 옵션: --${a.slice(2).split('=')[0]} (옵션은 --as-of, --member 만 있습니다.)`);
    if (eq !== -1) {
      found[name] = a.slice(eq + 1);
    } else {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${name} 값이 필요합니다.`);
      found[name] = v;
      i += 1;
    }
  }
  return found;
}

/**
 * @param job 실행할 잡 이름(cli 레지스트리 키)
 * @param args 잡 이름 뒤의 인자들 (process.argv.slice(3))
 */
export function parseTestOptions(job: string, args: string[], env: TestOptionsEnv): TestOptions {
  const found = readOptions(args);
  const asOf = found['as-of'];
  const member = found.member;
  const out: TestOptions = {};
  if (asOf !== undefined) {
    if (!validYmd(asOf)) throw new Error('--as-of 는 유효한 YYYY-MM-DD 여야 합니다.');
    out.asOf = asOf;
  }
  if (member !== undefined) {
    if (member.trim() === '') throw new Error('--member 값이 필요합니다.');
    out.memberId = member;
  }
  if (out.asOf === undefined && out.memberId === undefined) return out;

  if (!TEST_OPTION_JOBS.includes(job)) {
    throw new Error(`--as-of/--member 는 ${TEST_OPTION_JOBS.join(' / ')} 잡에서만 쓸 수 있습니다. (job=${job})`);
  }
  if (!isExplicitNonProduction(env.NODE_ENV)) {
    throw new Error('--as-of/--member 는 NODE_ENV 가 local·development·dev·test 로 명시된 비운영 환경에서만 쓸 수 있습니다. (운영·미주입은 거부)');
  }
  if (!isLocalUrl(env.DANAL_API_BASE_URL)) {
    throw new Error('--as-of/--member 는 DANAL_API_BASE_URL 이 localhost/127.0.0.1 일 때만 쓸 수 있습니다.');
  }
  const target = `${env.DB_HOST || DEFAULT_DB_HOST}/${env.DB_NAME || DEFAULT_DB_NAME}`;
  if (env.BILLING_TEST_DB_CONFIRM !== target) {
    throw new Error(`--as-of/--member 는 대상 DB 를 확인해야 합니다. 이 DB 에 쓰는 것이 맞다면 BILLING_TEST_DB_CONFIRM=${target} 을 지정하세요.`);
  }
  return out;
}
