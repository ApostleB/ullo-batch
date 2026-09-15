/**
 * 결제창 이탈 READY 정리 — **정상 결제를 취소로 만들 위험**이 있는 잡의 회귀 테스트.
 *
 * 이 잡의 안전장치는 전부 SQL WHERE 절에 있다. 조건이 하나라도 빠지면
 * 승인된 결제나 방금 시작한 결제까지 ABORTED 로 만든다.
 * 그래서 여기서는 **어떤 조건으로 질의하는가**를 검증한다.
 */
const query = jest.fn();
jest.mock('../db/data-source', () => ({ AppDataSource: { query: (...a: unknown[]) => query(...a) } }));
jest.mock('../config', () => ({ config: { params: { paymentReadyAbortHours: 24 } } }));

import { execute, JOB_NAME } from './payment-ready-cleanup.job';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** [count 결과, update 결과] 순으로 응답을 세팅한다 */
const prime = (count: number, updated = count) => {
  query.mockReset();
  query.mockResolvedValueOnce([{ cnt: count }]);
  if (count > 0) query.mockResolvedValueOnce(Array.from({ length: updated }, (_, i) => ({ payment_id: `p${i}` })));
};

const sqlOf = (call: number) => String(query.mock.calls[call][0]);

beforeEach(() => jest.clearAllMocks());

describe('payment-ready-cleanup — 안전장치 조건', () => {
  it('대상이 0건이면 UPDATE 를 실행하지 않는다', async () => {
    prime(0);
    await execute(log);
    expect(query).toHaveBeenCalledTimes(1); // count 만
  });

  it('READY 상태만 건드린다(DONE/ABORTED 보호)', async () => {
    prime(2);
    await execute(log);
    expect(sqlOf(1)).toContain("status = 'READY'");
  });

  it('승인 흔적(tid)이 있는 건은 제외한다 — 승인된 결제 보호', async () => {
    prime(2);
    await execute(log);
    // payment_key 가 있으면 PG 승인이 진행된 것 → 배치가 임의로 취소하면 안 된다
    expect(sqlOf(1)).toContain('payment_key IS NULL');
  });

  it('요청시각이 없는 행은 제외한다(aging 불가 → 안전 우선)', async () => {
    prime(2);
    await execute(log);
    expect(sqlOf(1)).toContain('requested_at IS NOT NULL');
  });

  it('경과 시간 조건을 건다 — 방금 시작한 결제 보호', async () => {
    prime(2);
    await execute(log);
    expect(sqlOf(1)).toMatch(/requested_at\s*<\s*\(now\(\)\s*-/);
  });

  it('경과 시간은 파라미터 바인딩으로 넘긴다', async () => {
    prime(1);
    await execute(log);
    expect(query.mock.calls[1][1]).toEqual([24]);
  });

  it('count 와 UPDATE 가 같은 조건을 쓴다(사이 유입 방어)', async () => {
    prime(3);
    await execute(log);
    for (const cond of ["status = 'READY'", 'payment_key IS NULL', 'requested_at IS NOT NULL']) {
      expect(sqlOf(0)).toContain(cond);
      expect(sqlOf(1)).toContain(cond);
    }
  });
});

describe('payment-ready-cleanup — 기록', () => {
  it('ABORTED 로 전이하고 사유를 남긴다', async () => {
    prime(1);
    await execute(log);
    const sql = sqlOf(1);
    expect(sql).toContain("status = 'ABORTED'");
    expect(sql).toContain('READY_TIMEOUT');
  });

  it('기존 실패 사유가 있으면 덮어쓰지 않는다(COALESCE)', async () => {
    prime(1);
    await execute(log);
    expect(sqlOf(1)).toMatch(/fail_code\s*=\s*COALESCE\(fail_code/);
  });
});

describe('payment-ready-cleanup — 멱등성', () => {
  it('재실행해도 이미 ABORTED 인 건은 다시 잡히지 않는다', async () => {
    prime(2);
    await execute(log);
    prime(0);
    await execute(log);
    // 두 번째 실행은 대상 0건 → UPDATE 없음
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('payment-ready-cleanup — 잡 이름', () => {
  it('advisory lock 키로 쓰이므로 고정되어야 한다', () => {
    expect(JOB_NAME).toBe('payment-ready-cleanup');
  });
});
