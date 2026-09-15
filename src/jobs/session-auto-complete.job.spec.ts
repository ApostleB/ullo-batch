/**
 * 수업 종료 자동 완료 — 활성화 시 **과거 데이터에 소급 적용**되는 잡의 회귀 테스트.
 *
 * COMPLETED 는 정산·리뷰의 근거라 잘못 전이하면 돈과 평판에 모두 영향이 간다.
 * 안전장치가 전부 SQL 조건절과 DRY-RUN 플래그에 있으므로 그것을 검증한다.
 */
const query = jest.fn();
jest.mock('../db/data-source', () => ({ AppDataSource: { query: (...a: unknown[]) => query(...a) } }));

const params = { sessionAutoCompleteGraceHours: 3, sessionAutoCompleteFromDate: null as string | null, sessionAutoCompleteDryRun: false };
jest.mock('../config', () => ({ config: { get params() { return params; } } }));

import { execute, JOB_NAME } from './session-auto-complete.job';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const prime = (count: number, updated = count) => {
  query.mockReset();
  query.mockResolvedValueOnce([{ cnt: count }]);
  if (count > 0) query.mockResolvedValueOnce(Array.from({ length: updated }, (_, i) => ({ member_class_session_id: `s${i}` })));
};
const sqlOf = (call: number) => String(query.mock.calls[call][0]);

beforeEach(() => {
  jest.clearAllMocks();
  params.sessionAutoCompleteGraceHours = 3;
  params.sessionAutoCompleteFromDate = null;
  params.sessionAutoCompleteDryRun = false;
});

describe('session-auto-complete — DRY-RUN (활성화 전 안전장치)', () => {
  it('DRY-RUN 이면 대상이 있어도 UPDATE 를 실행하지 않는다', async () => {
    params.sessionAutoCompleteDryRun = true;
    prime(500);

    await execute(log);

    expect(query).toHaveBeenCalledTimes(1); // count 만
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('DRY-RUN'));
  });

  it('DRY-RUN 해제 시에만 실제로 전이한다', async () => {
    params.sessionAutoCompleteDryRun = false;
    prime(2);

    await execute(log);

    expect(query).toHaveBeenCalledTimes(2);
    expect(sqlOf(1)).toContain('UPDATE member_class_session');
  });
});

describe('session-auto-complete — 대상 조건', () => {
  it('BOOKED 만 전이한다(이미 처리된 세션 보호)', async () => {
    prime(1);
    await execute(log);
    // NO_SHOW/CANCELLED/COMPLETED 를 덮어쓰면 정산·리뷰가 뒤집힌다
    expect(sqlOf(1)).toContain("mcs.session_status = 'BOOKED'");
  });

  it('삭제된 세션·취소된 스케줄은 제외한다', async () => {
    prime(1);
    await execute(log);
    const sql = sqlOf(1);
    expect(sql).toContain("COALESCE(mcs.is_del::text, 'N') = 'N'");
    expect(sql).toContain("COALESCE(sch.is_del::text, 'N') <> 'Y'");
  });

  it('종료시각 + 유예시간이 지난 것만 대상으로 한다', async () => {
    prime(1);
    await execute(log);
    expect(sqlOf(1)).toMatch(/scheduled_date \+ sch\.end_time\) < \(now\(\) -/);
  });

  it('유예시간을 파라미터로 넘긴다', async () => {
    params.sessionAutoCompleteGraceHours = 6;
    prime(1);
    await execute(log);
    expect(query.mock.calls[1][1][0]).toBe(6);
  });

  it('end_time 이 없는 스케줄은 제외한다(종료시각 계산 불가)', async () => {
    prime(1);
    await execute(log);
    expect(sqlOf(1)).toContain('sch.end_time IS NOT NULL');
  });
});

describe('session-auto-complete — 백필 하한(소급 폭탄 방어)', () => {
  it('하한일이 없으면 전체 과거가 대상이다', async () => {
    params.sessionAutoCompleteFromDate = null;
    prime(1);
    await execute(log);
    expect(query.mock.calls[1][1][1]).toBeNull();
  });

  it('하한일을 주면 그 이후 수업만 대상으로 좁힌다', async () => {
    params.sessionAutoCompleteFromDate = '2026-09-01';
    prime(1);
    await execute(log);
    expect(query.mock.calls[1][1][1]).toBe('2026-09-01');
    expect(sqlOf(1)).toContain('sch.scheduled_date >= $2::date');
  });
});

describe('session-auto-complete — 완료 시각', () => {
  it('배치 실행시각이 아니라 실제 수업 종료시각을 기록한다', async () => {
    prime(1);
    await execute(log);
    // now() 를 넣으면 리뷰 허용기간이 밀려버린다
    expect(sqlOf(1)).toMatch(/completed_at = \(sch\.scheduled_date \+ sch\.end_time\)/);
  });
});

describe('session-auto-complete — 멱등성 / 잡 이름', () => {
  it('대상 0건이면 UPDATE 를 실행하지 않는다', async () => {
    prime(0);
    await execute(log);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('advisory lock 키로 쓰이므로 고정되어야 한다', () => {
    expect(JOB_NAME).toBe('session-auto-complete');
  });
});
