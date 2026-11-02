import { parseLocalDate, setAsOfDate } from './date.util';

/**
 * 재현 테스트 전용 CLI 옵션 (`npm run job billing -- --as-of YYYY-MM-DD --member <id>`).
 * 스케줄러 경로(index.ts)는 이 모듈을 호출하지 않으므로 옵션이 켜질 수 없다.
 * 운영(NODE_ENV=production|prod)이거나 DANAL_API_BASE_URL 이 localhost/127.0.0.1 이 아니면 즉시 거부한다.
 */
export interface TestOptions {
  asOf?: string;
  memberId?: string;
}

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

function readOpt(argv: string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} 값이 필요합니다.`);
      return v;
    }
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
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

export function parseTestOptions(
  argv: string[],
  env: { NODE_ENV?: string; DANAL_API_BASE_URL?: string },
): TestOptions {
  const asOf = readOpt(argv, 'as-of');
  const member = readOpt(argv, 'member');
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

  if (['prod', 'production'].includes(String(env.NODE_ENV ?? '').toLowerCase())) {
    throw new Error('--as-of/--member 는 운영(production) 환경에서 쓸 수 없습니다.');
  }
  if (!isLocalUrl(env.DANAL_API_BASE_URL)) {
    throw new Error('--as-of/--member 는 DANAL_API_BASE_URL 이 localhost/127.0.0.1 일 때만 쓸 수 있습니다.');
  }
  return out;
}
