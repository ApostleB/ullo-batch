/**
 * 반복 스케줄 롤링 생성 — **예약 가능일을 만드는 잡**의 회귀 테스트.
 *
 * 끊기면 회원이 예약할 날짜 자체가 없어져 매출이 멈춘다.
 * 반대로 잘못 만들면 휴일·종료일 이후에도 예약이 열린다.
 */
import { ActiveStatus, IsYn } from '../entities/enums';

const repos: Record<string, any> = {};
jest.mock('../db/data-source', () => ({
  AppDataSource: { getRepository: (e: { name: string }) => repos[e.name] },
}));
jest.mock('../config', () => ({ config: { params: { rollingHorizonDays: 14 } } }));

import { execute } from './rolling-schedule.job';
import { addDays, dowCode, ymd } from '../utils/date.util';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const saved: any[] = [];

const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);
/** 오늘 기준 n일 뒤 'YYYY-MM-DD' */
const day = (n: number) => ymd(addDays(TODAY, n));
/** 오늘 기준 n일 뒤의 요일 코드 */
const dow = (n: number) => dowCode(addDays(TODAY, n));

const timeTable = (over: Record<string, unknown> = {}) => ({
  class_time_table_id: 'tt1',
  class_id: 'c1',
  is_repeat: IsYn.Y,
  is_del: IsYn.N,
  start_time: '10:00',
  end_time: '12:00',
  duration: 60,
  break_time: 0,
  start_date: null,
  end_date: null,
  max_capacity: 10,
  ...over,
});

function setup(opts: {
  timeTables?: unknown[];
  cls?: unknown;
  repeatDays?: string[];
  existing?: string[];
  holidays?: string[];
} = {}) {
  saved.length = 0;
  repos.ClassTimeTable = { find: jest.fn().mockResolvedValue(opts.timeTables ?? [timeTable()]) };
  repos.StudioClass = {
    find: jest.fn().mockResolvedValue([
      'cls' in opts ? opts.cls : { class_id: 'c1', is_del: IsYn.N, is_active: ActiveStatus.Y, max_capacity: 5 },
    ].filter(Boolean)),
  };
  repos.ClassRepeatDay = {
    find: jest.fn().mockResolvedValue((opts.repeatDays ?? [dow(1)]).map((d) => ({ day_of_week: d }))),
  };
  repos.ClassHoliday = {
    find: jest.fn().mockResolvedValue((opts.holidays ?? []).map((d) => ({ holiday_date: d }))),
  };
  repos.ClassSchedule = {
    find: jest.fn().mockResolvedValue((opts.existing ?? []).map((d) => ({ scheduled_date: d }))),
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (rows: any[]) => {
      saved.push(...rows);
      return rows;
    }),
  };
}

beforeEach(() => jest.clearAllMocks());

/** 생성된 날짜 집합 */
const dates = () => Array.from(new Set(saved.map((r) => ymd(new Date(r.scheduled_date))))).sort();

describe('rolling-schedule — 슬롯 분할', () => {
  it('10:00~12:00 / 60분 / 휴식 0 → 2슬롯', async () => {
    setup();
    await execute(log);
    const perDay = saved.filter((r) => ymd(new Date(r.scheduled_date)) === dates()[0]);
    expect(perDay.map((s) => `${s.start_time}-${s.end_time}`)).toEqual(['10:00:00-11:00:00', '11:00:00-12:00:00']);
  });

  it('휴식시간이 있으면 그만큼 밀린다', async () => {
    setup({ timeTables: [timeTable({ break_time: 30 })] });
    await execute(log);
    const perDay = saved.filter((r) => ymd(new Date(r.scheduled_date)) === dates()[0]);
    // 10:00-11:00, (30분 휴식), 11:30-12:00 은 60분이 안 되므로 생성 안 됨
    expect(perDay.map((s) => s.start_time)).toEqual(['10:00:00']);
  });

  it('소요시간이 영업시간보다 길면 아무 슬롯도 안 만든다', async () => {
    setup({ timeTables: [timeTable({ duration: 180 })] });
    await execute(log);
    expect(saved).toHaveLength(0);
  });
});

describe('rolling-schedule — 제외 규칙', () => {
  it('반복 요일이 아닌 날은 만들지 않는다', async () => {
    setup({ repeatDays: [dow(1)] });
    await execute(log);
    dates().forEach((d) => expect(dowCode(new Date(d))).toBe(dow(1)));
  });

  it('이미 존재하는 날짜는 건너뛴다(중복 생성 방지)', async () => {
    setup({ repeatDays: [dow(1)], existing: [day(1)] });
    await execute(log);
    expect(dates()).not.toContain(day(1));
  });

  it('휴일은 건너뛴다', async () => {
    setup({ repeatDays: [dow(1)], holidays: [day(1)] });
    await execute(log);
    expect(dates()).not.toContain(day(1));
  });

  it('비활성 클래스는 스킵한다', async () => {
    setup({ cls: { class_id: 'c1', is_del: IsYn.N, is_active: ActiveStatus.N, max_capacity: 5 } });
    await execute(log);
    expect(saved).toHaveLength(0);
  });

  it('삭제된 클래스는 스킵한다', async () => {
    setup({ cls: { class_id: 'c1', is_del: IsYn.Y, is_active: ActiveStatus.Y, max_capacity: 5 } });
    await execute(log);
    expect(saved).toHaveLength(0);
  });

  it('is_del 이 NULL 인 클래스는 정상으로 취급한다(삭제로 오인 금지)', async () => {
    // 과거에 `!== IsYn.N` 조건이 NULL 정상 클래스를 조용히 제외한 전례가 있다.
    setup({ cls: { class_id: 'c1', is_del: null, is_active: ActiveStatus.Y, max_capacity: 5 } });
    await execute(log);
    expect(saved.length).toBeGreaterThan(0);
  });

  it('반복 요일이 하나도 지정 안 됐으면 만들지 않는다', async () => {
    setup({ repeatDays: [] });
    await execute(log);
    expect(saved).toHaveLength(0);
  });

  it('요일 코드 포맷이 다르면 경고하고 0건(조용한 실패 방지)', async () => {
    setup({ repeatDays: ['MONDAY', '월'] });
    await execute(log);
    expect(saved).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('반복 요일 포맷 불일치'));
  });
});

describe('rolling-schedule — 기간 경계', () => {
  it('종료일 이후로는 만들지 않는다', async () => {
    setup({ timeTables: [timeTable({ end_date: day(3) })], repeatDays: [dow(1), dow(2), dow(5), dow(8)] });
    await execute(log);
    dates().forEach((d) => expect(d <= day(3)).toBe(true));
  });

  it('시작일 이전으로는 만들지 않는다', async () => {
    setup({ timeTables: [timeTable({ start_date: day(5) })], repeatDays: [dow(1), dow(5), dow(8)] });
    await execute(log);
    dates().forEach((d) => expect(d >= day(5)).toBe(true));
  });

  it('종료일이 시작일보다 빠르면 0건', async () => {
    setup({ timeTables: [timeTable({ start_date: day(10), end_date: day(3) })] });
    await execute(log);
    expect(saved).toHaveLength(0);
  });

  it('horizon(14일)을 넘겨 만들지 않는다', async () => {
    setup({ repeatDays: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] });
    await execute(log);
    dates().forEach((d) => expect(d <= day(14)).toBe(true));
  });
});

describe('rolling-schedule — 생성 값', () => {
  it('시간표 정원이 있으면 그것을, 없으면 클래스 정원을 쓴다', async () => {
    setup();
    await execute(log);
    expect(saved[0].max_capacity).toBe(10);

    setup({ timeTables: [timeTable({ max_capacity: null })] });
    await execute(log);
    expect(saved[0].max_capacity).toBe(5);
  });

  it('OPEN 상태·정원 0명으로 생성한다', async () => {
    setup();
    await execute(log);
    expect(saved[0]).toMatchObject({ status: 'OPEN', current_capacity: 0, is_del: IsYn.N });
  });
});
