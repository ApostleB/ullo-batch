/** Date → 'YYYY-MM-DD' (로컬 기준) */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 로컬 자정 Date */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/**
 * TypeORM date 컬럼 값(런타임에는 'YYYY-MM-DD' 문자열, 혹은 Date)을 로컬 자정 Date로 정규화.
 * new Date('YYYY-MM-DD')는 UTC 자정으로 파싱되어 음수 오프셋/경계일에서 하루가 어긋나므로
 * 문자열은 parseLocalDate로 처리한다.
 */
export function toLocalDate(v: Date | string): Date {
  if (typeof v === 'string') return parseLocalDate(v.slice(0, 10));
  const r = new Date(v);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** 오늘 로컬 자정 */
export function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** n일 더한 로컬 자정 Date */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  r.setHours(0, 0, 0, 0);
  return r;
}

/**
 * 월 단위 가산 + 월말 클램프.
 * 예) 1/31 + 1개월 → 2/28(또는 2/29). 결제 앵커 일자 유지.
 */
export function addMonthsClamped(d: Date, n: number): Date {
  const day = d.getDate();
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1, 0, 0, 0, 0);
  const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, lastDay));
  return r;
}

/** 'HH:MM' 또는 'HH:MM:SS' → 분 */
export function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** 분 → 'HH:MM:SS' */
export function toTimeString(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

/** dowCode()가 사용하는 유효 요일 코드 집합 */
export const DOW_CODES: ReadonlySet<string> = new Set(DOW);

/** Date → 요일 코드 (SUN..SAT) */
export function dowCode(d: Date): string {
  return DOW[d.getDay()];
}
