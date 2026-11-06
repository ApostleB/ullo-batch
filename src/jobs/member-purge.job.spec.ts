/**
 * 탈퇴 회원 분리보관 개인정보 최종 파기 — **되돌릴 수 없는 삭제**의 회귀 테스트.
 *
 * 잘못되면 두 방향 모두 사고다:
 *  - 너무 일찍 지우면 → 보관 의무 기간 내 자료 소실
 *  - 안 지우거나 일부만 지우면 → 보관기간 초과 개인정보 잔존
 */
import { IsYn } from '../entities/enums';

const repo: any = {};
/** 트랜잭션 매니저 목 — 파기 UPDATE 와 메모 DELETE 가 같은 매니저(트랜잭션)로 실행되는지 본다 */
const runner: any = { query: jest.fn() };
const manager: any = { getRepository: () => repo, queryRunner: runner };
const tx = { begun: 0, committed: 0, rolledBack: 0 };
jest.mock('../db/data-source', () => ({
  AppDataSource: {
    getRepository: () => repo,
    // TypeORM transaction 처럼: 콜백이 던지면 롤백 후 예외를 그대로 전파, 아니면 커밋
    transaction: async (cb: (m: unknown) => Promise<unknown>) => {
      tx.begun++;
      try {
        const r = await cb(manager);
        tx.committed++;
        return r;
      } catch (e) {
        tx.rolledBack++;
        throw e;
      }
    },
  },
}));

import { execute, JOB_NAME } from './member-purge.job';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** update().set(...).where(...).andWhere(...).returning(...).execute() 체인 목 */
function makeQb(affected = 0, memberIds: string[] = Array.from({ length: affected }, (_, i) => `m${i + 1}`)) {
  const captured: { set?: Record<string, unknown>; where: [string, unknown][] } = { where: [] };
  const qb: any = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn((v: Record<string, unknown>) => {
      captured.set = v;
      return qb;
    }),
    where: jest.fn((c: string, p: unknown) => {
      captured.where.push([c, p]);
      return qb;
    }),
    andWhere: jest.fn((c: string, p: unknown) => {
      captured.where.push([c, p]);
      return qb;
    }),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected, raw: memberIds.map((member_id) => ({ member_id })) }),
  };
  return { qb, captured };
}

beforeEach(() => {
  jest.clearAllMocks();
  tx.begun = tx.committed = tx.rolledBack = 0;
  runner.query = jest.fn().mockResolvedValue({ records: [], affected: 0 });
});

describe('member-purge — 대상 선정', () => {
  it('대상이 0건이면 UPDATE 를 아예 실행하지 않는다', async () => {
    repo.count = jest.fn().mockResolvedValue(0);
    repo.createQueryBuilder = jest.fn();

    await execute(log);

    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('미파기 + 보관기간 경과 조건으로만 센다', async () => {
    repo.count = jest.fn().mockResolvedValue(0);
    repo.createQueryBuilder = jest.fn();

    await execute(log);

    const where = repo.count.mock.calls[0][0].where;
    expect(where.is_purged).toBe(IsYn.N);
    // purge_at <= now (LessThanOrEqual) — 미래 분은 절대 대상이 아니다
    expect(where.purge_at).toBeDefined();
  });

  it('UPDATE 에도 같은 조건을 다시 건다(count 와 실행 사이 유입 방어)', async () => {
    repo.count = jest.fn().mockResolvedValue(3);
    const { qb, captured } = makeQb(3);
    repo.createQueryBuilder = jest.fn(() => qb);

    await execute(log);

    const conds = captured.where.map(([c]) => c).join(' | ');
    expect(conds).toContain('is_purged = :n');
    expect(conds).toContain('purge_at <= :now');
    expect(captured.where.find(([c]) => c.includes('is_purged'))![1]).toEqual({ n: IsYn.N });
  });
});

describe('member-purge — 무엇을 지우는가', () => {
  /**
   * 핵심 회귀 방지.
   * `member_withdrawal` 에 개인정보 컬럼이 추가됐는데 이 SET 목록에 넣지 않으면
   * **보관기간이 지나도 그 정보만 살아남는다.** 컬럼 추가 시 이 테스트가 깨져야 한다.
   */
  const PII_COLUMNS = [
    'member_email',
    'member_name',
    'member_nickname',
    'member_mobile',
    'gender',
    'provider_ref',
    'withdraw_reason',
  ];

  it('엔티티의 개인정보 컬럼을 빠짐없이 null 로 만든다', async () => {
    repo.count = jest.fn().mockResolvedValue(1);
    const { qb, captured } = makeQb(1);
    repo.createQueryBuilder = jest.fn(() => qb);

    await execute(log);

    for (const col of PII_COLUMNS) {
      expect(captured.set).toHaveProperty(col);
      expect(captured.set![col]).toBeNull();
    }
  });

  it('파기 표시(is_purged=Y, purged_at)를 남긴다', async () => {
    repo.count = jest.fn().mockResolvedValue(1);
    const { qb, captured } = makeQb(1);
    repo.createQueryBuilder = jest.fn(() => qb);

    await execute(log);

    expect(captured.set!.is_purged).toBe(IsYn.Y);
    expect(captured.set!.purged_at).toBeInstanceOf(Date);
  });

  it('감사 추적용 식별자·시각은 건드리지 않는다(툼스톤 유지)', async () => {
    repo.count = jest.fn().mockResolvedValue(1);
    const { qb, captured } = makeQb(1);
    repo.createQueryBuilder = jest.fn(() => qb);

    await execute(log);

    // member_id / withdrawn_at / purge_at 이 지워지면 "언제 누가 탈퇴했는지"를 잃는다.
    for (const keep of ['member_id', 'withdrawn_at', 'purge_at', 'member_withdrawal_id']) {
      expect(captured.set).not.toHaveProperty(keep);
    }
  });
});

describe('member-purge — 멱등성', () => {
  it('이미 파기된 행은 조건에서 제외되므로 재실행해도 안전하다', async () => {
    repo.count = jest.fn().mockResolvedValue(2);
    const { qb, captured } = makeQb(2);
    repo.createQueryBuilder = jest.fn(() => qb);

    await execute(log);
    await execute(log);

    // 두 번 모두 is_purged='N' 조건이 걸려 있으면 이미 Y 인 행은 다시 잡히지 않는다
    const purgedConds = captured.where.filter(([c]) => c.includes('is_purged'));
    expect(purgedConds.length).toBe(2);
    purgedConds.forEach(([, p]) => expect(p).toEqual({ n: IsYn.N }));
  });
});

describe('member-purge — 파트너 회원 메모 물리 삭제(W5c)', () => {
  it('이번에 파기된 회원의 메모만 is_del 과 무관하게 DELETE 한다', async () => {
    repo.count = jest.fn().mockResolvedValue(2);
    const { qb } = makeQb(2, ['mem-a', 'mem-b']);
    repo.createQueryBuilder = jest.fn(() => qb);
    runner.query = jest.fn().mockResolvedValue({ records: [], affected: 5 });

    await execute(log);

    // UPDATE ... RETURNING member_id 로 이번에 N→Y 된 회원을 얻는다
    expect(qb.returning).toHaveBeenCalledWith(['member_id']);
    expect(runner.query).toHaveBeenCalledTimes(1);
    const [sql, params] = runner.query.mock.calls[0];
    expect(sql).toMatch(/^DELETE FROM partner_member_memo WHERE member_id = ANY\(\$1::uuid\[\]\)$/);
    expect(sql).not.toMatch(/is_del/); // 소프트 삭제된 메모도 함께 물리 삭제
    expect(params).toEqual([['mem-a', 'mem-b']]);
    // 같은 트랜잭션에서 실행되고 커밋된다
    expect(tx).toEqual({ begun: 1, committed: 1, rolledBack: 0 });
  });

  it('파기·메모 삭제 건수만 로그에 남기고 member_id 는 남기지 않는다', async () => {
    repo.count = jest.fn().mockResolvedValue(2);
    const { qb } = makeQb(2, ['mem-a', 'mem-b']);
    repo.createQueryBuilder = jest.fn(() => qb);
    runner.query = jest.fn().mockResolvedValue({ records: [], affected: 5 });

    await execute(log);

    const msg = log.info.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(msg).toContain('처리 2건');
    expect(msg).toContain('메모 삭제 5건');
    expect(msg).not.toContain('mem-a');
    expect(msg).not.toContain('mem-b');
  });

  it('같은 회원의 분리보관 행이 여럿이어도 member_id 는 한 번만 넘긴다', async () => {
    repo.count = jest.fn().mockResolvedValue(2);
    const { qb } = makeQb(2, ['mem-a', 'mem-a']);
    repo.createQueryBuilder = jest.fn(() => qb);

    await execute(log);

    expect(runner.query.mock.calls[0][1]).toEqual([['mem-a']]);
  });

  it('대상이 없으면 트랜잭션도 메모 DELETE 도 실행하지 않는다', async () => {
    repo.count = jest.fn().mockResolvedValue(0);
    repo.createQueryBuilder = jest.fn();

    await execute(log);

    expect(tx.begun).toBe(0);
    expect(runner.query).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('파기 대상 없음 — 종료');
  });

  it('count 이후 경합으로 UPDATE 가 0건이면 메모 DELETE 를 하지 않는다', async () => {
    repo.count = jest.fn().mockResolvedValue(1);
    const { qb } = makeQb(0, []);
    repo.createQueryBuilder = jest.fn(() => qb);

    await execute(log);

    expect(runner.query).not.toHaveBeenCalled();
    expect(tx).toEqual({ begun: 1, committed: 1, rolledBack: 0 });
  });

  it('메모 DELETE 가 실패하면 예외를 던져 파기 UPDATE 까지 롤백된다(다음 실행에서 재시도)', async () => {
    repo.count = jest.fn().mockResolvedValue(1);
    const { qb } = makeQb(1, ['mem-a']);
    repo.createQueryBuilder = jest.fn(() => qb);
    runner.query = jest
      .fn()
      .mockRejectedValue(new Error('relation "partner_member_memo" does not exist'));

    await expect(execute(log)).rejects.toThrow('partner_member_memo');

    // 파기 UPDATE 는 같은 트랜잭션 안에서 실행됐고, 그 트랜잭션이 커밋되지 않고 롤백됐다
    expect(qb.execute).toHaveBeenCalledTimes(1);
    expect(tx).toEqual({ begun: 1, committed: 0, rolledBack: 1 });
    // 완료 로그를 남기지 않는다
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('파기 완료'));
  });
});

describe('member-purge — 잡 이름', () => {
  it('advisory lock 키로 쓰이므로 고정되어야 한다', () => {
    expect(JOB_NAME).toBe('member-purge');
  });
});
