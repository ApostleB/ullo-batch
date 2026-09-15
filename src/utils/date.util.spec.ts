import {
  addDays,
  addMonthsClamped,
  dowCode,
  DOW_CODES,
  parseLocalDate,
  toLocalDate,
  toMinutes,
  toTimeString,
  today,
  ymd,
} from './date.util';

/**
 * 배치의 날짜 유틸은 정산 기간·스케줄 생성일·구독 청구일을 결정한다.
 * 하루가 밀리면 정산이 한 달 경계에서 새거나 스케줄이 하루 비므로 회귀를 반드시 잡아야 한다.
 */
describe('date.util — 로컬(KST) 경계', () => {
  describe('toLocalDate — UTC 파싱으로 인한 하루 밀림 방지', () => {
    it("'YYYY-MM-DD' 문자열을 로컬 자정으로 읽는다", () => {
      const d = toLocalDate('2026-09-09');
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(8); // 0-based
      expect(d.getDate()).toBe(9);
      expect(d.getHours()).toBe(0);
    });

    it('new Date(문자열) 과 달라야 한다(UTC 자정 파싱 회피)', () => {
      // new Date('2026-09-09') 는 UTC 자정 → KST 로는 09:00.
      // 유틸은 로컬 자정이어야 하므로 시각이 서로 달라야 정상이다.
      const naive = new Date('2026-09-09');
      const safe = toLocalDate('2026-09-09');
      expect(safe.getHours()).toBe(0);
      expect(safe.getTime()).not.toBe(naive.getTime());
    });

    it('Date 를 받으면 시각만 잘라 로컬 자정으로 만든다', () => {
      const d = toLocalDate(new Date(2026, 8, 9, 23, 59, 59, 999));
      expect(ymd(d)).toBe('2026-09-09');
      expect(d.getHours()).toBe(0);
    });

    it("타임스탬프 문자열도 날짜 부분만 쓴다", () => {
      expect(ymd(toLocalDate('2026-09-09T23:30:00.000Z'))).toBe('2026-09-09');
    });
  });

  describe('ymd / parseLocalDate 왕복', () => {
    it('왕복해도 같은 날짜', () => {
      for (const s of ['2026-01-01', '2026-02-28', '2026-12-31', '2027-03-01']) {
        expect(ymd(parseLocalDate(s))).toBe(s);
      }
    });

    it('한 자리 월/일도 0 패딩', () => {
      expect(ymd(new Date(2026, 0, 5))).toBe('2026-01-05');
    });
  });

  describe('addMonthsClamped — 결제 앵커 일자 유지', () => {
    it('1/31 + 1개월 → 2월 말일로 클램프', () => {
      expect(ymd(addMonthsClamped(parseLocalDate('2026-01-31'), 1))).toBe('2026-02-28');
    });

    it('윤년이면 2/29 로 클램프', () => {
      expect(ymd(addMonthsClamped(parseLocalDate('2028-01-31'), 1))).toBe('2028-02-29');
    });

    it('말일이 아니면 일자를 그대로 유지', () => {
      expect(ymd(addMonthsClamped(parseLocalDate('2026-01-15'), 1))).toBe('2026-02-15');
    });

    it('연도를 넘어가도 정상', () => {
      expect(ymd(addMonthsClamped(parseLocalDate('2026-12-31'), 1))).toBe('2027-01-31');
    });

    it('클램프된 뒤에도 원래 일자로 복귀하지 않는다(누적 이동 주의)', () => {
      // 1/31 → 2/28 → 3/28. 앵커를 매번 원본에서 계산해야 3/31 이 된다.
      const feb = addMonthsClamped(parseLocalDate('2026-01-31'), 1);
      expect(ymd(addMonthsClamped(feb, 1))).toBe('2026-03-28');
      expect(ymd(addMonthsClamped(parseLocalDate('2026-01-31'), 2))).toBe('2026-03-31');
    });
  });

  describe('addDays', () => {
    it('월/연 경계를 넘는다', () => {
      expect(ymd(addDays(parseLocalDate('2026-01-31'), 1))).toBe('2026-02-01');
      expect(ymd(addDays(parseLocalDate('2026-12-31'), 1))).toBe('2027-01-01');
    });

    it('음수면 과거로 간다', () => {
      expect(ymd(addDays(parseLocalDate('2026-03-01'), -1))).toBe('2026-02-28');
    });

    it('원본을 변경하지 않는다', () => {
      const base = parseLocalDate('2026-09-09');
      addDays(base, 10);
      expect(ymd(base)).toBe('2026-09-09');
    });
  });

  describe('시간 변환', () => {
    it('HH:MM / HH:MM:SS 모두 분으로', () => {
      expect(toMinutes('09:30')).toBe(570);
      expect(toMinutes('09:30:00')).toBe(570);
      expect(toMinutes('00:00')).toBe(0);
      expect(toMinutes('23:59')).toBe(1439);
    });

    it('분 → HH:MM:SS 왕복', () => {
      for (const t of ['00:00:00', '09:30:00', '23:59:00']) {
        expect(toTimeString(toMinutes(t))).toBe(t);
      }
    });
  });

  describe('요일 코드', () => {
    it('2026-09-09 는 수요일', () => {
      expect(dowCode(parseLocalDate('2026-09-09'))).toBe('WED');
    });

    it('7일치가 모두 유효 코드이며 서로 다르다', () => {
      const base = parseLocalDate('2026-09-06'); // 일요일
      const codes = Array.from({ length: 7 }, (_, i) => dowCode(addDays(base, i)));
      expect(codes).toEqual(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
      codes.forEach((c) => expect(DOW_CODES.has(c)).toBe(true));
    });
  });

  describe('today', () => {
    it('시각이 0시로 정규화된다', () => {
      const t = today();
      expect([t.getHours(), t.getMinutes(), t.getSeconds(), t.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    });
  });
});
