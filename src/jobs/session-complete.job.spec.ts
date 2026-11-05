/**
 * 수업 종료 처리 — 파트너 정산(COMPLETED 집계)과 회원 이용완료·노쇼를 확정하는 잡의 회귀 테스트.
 *
 * 마감(CLOSED) 회차가 대상에서 빠지면 회차·예약이 영원히 그대로 남아 정산에서 누락되고,
 * 처리 중(HOLD)·취소(CANCELLED) 회차가 대상에 들어가면 운영자가 막아 둔 회차가 확정된다.
 * DB 는 목킹하고 "어떤 상태값을 어떤 SQL 파라미터로 넘기는가"를 검증한다.
 */
const runner: any = {};
jest.mock('../db/data-source', () => ({
  AppDataSource: { createQueryRunner: () => runner },
}));

import { execute, JOB_NAME } from './session-complete.job';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

type Call = { sql: string; params: unknown[] };

const isStart = (c: Call) => /sch\.status = \$\d/.test(c.sql);
const isClaim = (c: Call) => /sch\.status IN \(/.test(c.sql);
const isSessionUpdate = (c: Call) => /UPDATE member_class_session/.test(c.sql);

/**
 * 종료 처리 대상 수업 ID(claimed)와 확정 후 세션 상태(sessions)를 돌려주는 QueryRunner 목.
 * 실제 SQL 평가는 하지 않으므로 대상 판정은 SQL·파라미터로 검증한다.
 */
function setup(opts: { claimed?: string[]; sessions?: string[]; sessionError?: Error } = {}) {
  const calls: Call[] = [];
  runner.connect = jest.fn().mockResolvedValue(undefined);
  runner.release = jest.fn().mockResolvedValue(undefined);
  runner.startTransaction = jest.fn().mockResolvedValue(undefined);
  runner.commitTransaction = jest.fn().mockResolvedValue(undefined);
  runner.rollbackTransaction = jest.fn().mockResolvedValue(undefined);
  runner.query = jest.fn(async (sql: string, params: unknown[]) => {
    const call = { sql, params };
    calls.push(call);
    if (isClaim(call)) {
      const records = (opts.claimed ?? []).map((id) => ({ class_schedule_id: id }));
      return { records, affected: records.length };
    }
    if (isSessionUpdate(call)) {
      if (opts.sessionError) throw opts.sessionError;
      const records = (opts.sessions ?? []).map((s) => ({ session_status: s }));
      return { records, affected: records.length };
    }
    return { records: [], affected: 0 };
  });
  return calls;
}

/** SQL 의 `$n` 자리표시자를 실제 파라미터 값으로 푼다 */
function paramAt(call: Call, placeholder: string): unknown {
  return call.params[Number(placeholder.slice(1)) - 1];
}

/** B-1 의 `sch.status IN (...)` 에 실제로 넘어가는 상태값 — 파라미터 번호가 바뀌어도 값으로 검증한다 */
function claimableStatuses(call: Call): string[] {
  const list = /sch\.status IN \(([^)]*)\)/.exec(call.sql)?.[1] ?? '';
  return list
    .split(',')
    .map((p) => String(paramAt(call, p.trim())))
    .sort();
}

beforeEach(() => jest.clearAllMocks());

describe('session-complete — 종료 처리 대상 상태', () => {
  it('OPEN·STARTED 와 함께 마감(CLOSED) 회차도 종료 처리한다', async () => {
    const calls = setup();
    await execute(log);

    expect(claimableStatuses(calls.find(isClaim)!)).toEqual(['CLOSED', 'OPEN', 'STARTED']);
  });

  it.each(['HOLD', 'CANCELLED', 'COMPLETED'])('%s 회차는 종료 처리 대상이 아니다', async (status) => {
    const calls = setup();
    await execute(log);

    expect(claimableStatuses(calls.find(isClaim)!)).not.toContain(status);
  });

  it('클레임 UPDATE 는 수업을 COMPLETED 로 바꾸고, 삭제된 수업은 제외한다', async () => {
    const calls = setup();
    await execute(log);

    const claim = calls.find(isClaim)!;
    expect(paramAt(claim, /SET status = (\$\d+)/.exec(claim.sql)![1])).toBe('COMPLETED');
    expect(claim.sql).toContain(`sch.is_del = 'N'`);
  });
});

describe('session-complete — 시작 처리(A)', () => {
  it('OPEN 만 STARTED 로 바꾼다 — CLOSED 는 시작 시각이 지나도 STARTED 가 되지 않는다', async () => {
    const calls = setup();
    await execute(log);

    const start = calls.find(isStart)!;
    expect(paramAt(start, /sch\.status = (\$\d+)/.exec(start.sql)![1])).toBe('OPEN');
    expect(paramAt(start, /SET status = (\$\d+)/.exec(start.sql)![1])).toBe('STARTED');
    expect(start.params).not.toContain('CLOSED');
  });
});

describe('session-complete — 유예 시간', () => {
  it('미체크인 BOOKED 예약이 있으면 컷오프를 종료시각 + 1시간으로 판정한다', async () => {
    const calls = setup();
    await execute(log);

    const claim = calls.find(isClaim)!;
    const grace = /WHEN EXISTS \(([\s\S]*?)\)\s*THEN INTERVAL '1 hour' ELSE INTERVAL '0' END\)\s*< LOCALTIMESTAMP/.exec(
      claim.sql,
    );
    expect(grace).not.toBeNull();
    expect(grace![1]).toContain('s.checked_in_at IS NULL');
    expect(paramAt(claim, /s\.session_status = (\$\d+)/.exec(grace![1])![1])).toBe('BOOKED');
  });

  it('유예 전이라 클레임된 수업이 없으면 세션을 건드리지 않는다', async () => {
    const calls = setup({ claimed: [] });
    await execute(log);

    expect(calls.some(isSessionUpdate)).toBe(false);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('마감 대상 수업 없음');
  });
});

describe('session-complete — 세션 확정', () => {
  it('클레임된 회차의 BOOKED 세션만 체크인 → COMPLETED / 미체크인 → NO_SHOW 로 확정한다', async () => {
    const calls = setup({ claimed: ['closed-1'], sessions: ['COMPLETED', 'NO_SHOW', 'NO_SHOW'] });
    await execute(log);

    const update = calls.find(isSessionUpdate)!;
    const [, whenChecked, otherwise] =
      /session_status = CASE WHEN s\.checked_in_at IS NOT NULL THEN (\$\d+) ELSE (\$\d+) END/.exec(update.sql)!;
    expect(paramAt(update, whenChecked)).toBe('COMPLETED');
    expect(paramAt(update, otherwise)).toBe('NO_SHOW');
    expect(paramAt(update, /s\.session_status = (\$\d+)/.exec(update.sql)![1])).toBe('BOOKED');
    expect(paramAt(update, /ANY\((\$\d+)::uuid\[\]\)/.exec(update.sql)![1])).toEqual(['closed-1']);

    expect(log.info).toHaveBeenCalledWith('수업 마감: 1건 (세션 COMPLETED 1 / NO_SHOW 2)');
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('세션 확정이 실패하면 회차 클레임까지 롤백하고 예외를 그대로 던진다', async () => {
    const boom = new Error('session update failed');
    setup({ claimed: ['closed-1'], sessionError: boom });

    await expect(execute(log)).rejects.toBe(boom);

    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});

describe('session-complete — 잡 메타데이터', () => {
  it('JOB_NAME 은 Advisory Lock 키이므로 바뀌면 안 된다', () => {
    expect(JOB_NAME).toBe('session-complete');
  });
});
