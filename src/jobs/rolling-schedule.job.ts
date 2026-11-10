import { Between, In } from 'typeorm';
import { AppDataSource } from '../db/data-source';
import { ClassTimeTable } from '../entities/class-time-table.entity';
import { ClassSchedule } from '../entities/class-schedule.entity';
import { ClassRepeatDay } from '../entities/class-repeat-day.entity';
import { ClassHoliday } from '../entities/class-holiday.entity';
import { StudioClass } from '../entities/studio-class.entity';
import { ActiveStatus, IsYn } from '../entities/enums';
import { config } from '../config';
import { addDays, dowCode, DOW_CODES, toLocalDate, toMinutes, toTimeString, today, ymd } from '../utils/date.util';
import { createJobLogger } from '../logger';

/**
 * 잡 이름은 ullo 와의 동시 생성 직렬화 키이기도 하다 — 바꾸지 말 것.
 *
 * `runJob()`(utils/run-job.ts)이 잡 전체 동안 별도 커넥션에서
 * `pg_try_advisory_lock(hashtext(JOB_NAME))` 세션 잠금을 쥔다. ullo 의 슬롯 저장·재활성화·
 * 어드민 수동 재생성은 같은 키 `pg_advisory_xact_lock(hashtext('rolling-schedule'))` 를 잡으므로
 * (세션·트랜잭션 advisory lock 은 같은 키 공간), 배치가 도는 동안 ullo 쪽은 배치가 끝나고
 * 잠금을 풀 때까지 기다리고, ullo 가 잠금을 쥔 순간에 배치가 시작되면 배치가 그 회를 건너뛴다.
 *
 * 이 잡 안에서 같은 키로 `pg_advisory_xact_lock` 을 다시 잡으면 안 된다: 트랜잭션은 풀의 다른
 * 커넥션이라 runJob 이 쥔 세션 잠금을 영원히 기다린다(자기 교착 → 잡 정지 + ullo 저장도 정지).
 */
export const JOB_NAME = 'rolling-schedule';

type Log = ReturnType<typeof createJobLogger>;

interface Slot {
  start: string;
  end: string;
}

function buildSlots(startTime: string, endTime: string, duration: number, breakTime: number): Slot[] {
  const slots: Slot[] = [];
  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  let cursor = startMin;
  while (cursor + duration <= endMin) {
    slots.push({ start: toTimeString(cursor), end: toTimeString(cursor + duration) });
    cursor += duration + breakTime;
  }
  return slots;
}

export async function execute(log: Log): Promise<void> {
  const horizonEnd = addDays(today(), config.params.rollingHorizonDays);
  log.info(`롤링 범위: ${ymd(today())} ~ ${ymd(horizonEnd)} (+${config.params.rollingHorizonDays}일)`);

  const ttRepo = AppDataSource.getRepository(ClassTimeTable);
  const timeTables = await ttRepo.find({
    where: { is_repeat: IsYn.Y, is_del: IsYn.N },
  });
  if (timeTables.length === 0) {
    log.info('반복 시간표 없음');
    return;
  }

  // 활성 클래스 맵 (capacity fallback + 비활성/삭제 클래스 제외)
  const classIds = Array.from(new Set(timeTables.map((t) => t.class_id).filter((v): v is string => !!v)));
  const classes = await AppDataSource.getRepository(StudioClass).find({ where: { class_id: In(classIds) } });
  const classMap = new Map(classes.map((c) => [c.class_id, c]));

  let createdTotal = 0;
  for (const tt of timeTables) {
    const cls = tt.class_id ? classMap.get(tt.class_id) : undefined;
    // is_del은 nullable — NULL은 "삭제 안 됨"을 뜻하는 관례이므로 명시적 삭제(Y)만 스킵한다.
    // (기존 `!== IsYn.N`은 is_del=NULL 정상 클래스까지 삭제로 취급해 조용히 제외했음)
    if (!cls || cls.is_del === IsYn.Y || cls.is_active !== ActiveStatus.Y) {
      continue; // 비활성/삭제 클래스 스킵
    }
    if (!tt.start_time || !tt.end_time || !tt.duration || tt.duration <= 0) {
      log.warn(`슬롯 생성 불가(시간/소요시간 없음) tt=${tt.class_time_table_id}`);
      continue;
    }

    const created = await rollOne(tt, cls, horizonEnd, log);
    createdTotal += created;
  }
  log.info(`스케줄 생성: 총 ${createdTotal}건`);
}

async function rollOne(
  tt: ClassTimeTable,
  cls: StudioClass,
  horizonEnd: Date,
  log: Log,
): Promise<number> {
  const scheduleRepo = AppDataSource.getRepository(ClassSchedule);

  // 생성 시작일 = max(오늘, 시작일)
  // date 컬럼은 런타임에 'YYYY-MM-DD' 문자열로 들어오므로 toLocalDate로 정규화(UTC off-by-one 방지)
  let from = today();
  if (tt.start_date && toLocalDate(tt.start_date) > from) from = toLocalDate(tt.start_date);
  from.setHours(0, 0, 0, 0);
  // 종료일이 horizon보다 빠르면 그날까지만
  const to = tt.end_date && toLocalDate(tt.end_date) < horizonEnd ? toLocalDate(tt.end_date) : horizonEnd;
  if (from > to) return 0;

  // 반복 요일
  const repeatDays = await AppDataSource.getRepository(ClassRepeatDay).find({
    where: { class_time_table_id: tt.class_time_table_id, is_del: IsYn.N },
  });
  const dowSet = new Set(repeatDays.map((r) => r.day_of_week).filter((v): v is string => !!v));
  if (dowSet.size === 0) return 0; // 반복 요일 미지정이면 생성 안 함

  // 요일 코드 포맷 검증 — DB 값이 dowCode()의 'SUN'..'SAT'와 다르면 영원히 매칭되지 않아
  // 조용히 0건이 생성된다. 유효 코드가 하나도 없으면 경고로 노출한다.
  if (![...dowSet].some((d) => DOW_CODES.has(d))) {
    log.warn(
      `반복 요일 포맷 불일치 tt=${tt.class_time_table_id} values=[${[...dowSet].join(',')}] ` +
        `(기대 포맷: ${[...DOW_CODES].join(',')})`,
    );
    return 0;
  }

  // 이미 존재하는 스케줄 날짜 (삭제분 포함 → 되살리지 않음)
  const existing = await scheduleRepo.find({
    where: { class_time_table_id: tt.class_time_table_id, scheduled_date: Between(from, to) },
    select: { scheduled_date: true },
  });
  const existingDates = new Set(existing.map((e) => (e.scheduled_date ? ymd(toLocalDate(e.scheduled_date)) : '')));

  // 휴일
  const holidays = await AppDataSource.getRepository(ClassHoliday).find({
    where: { class_id: cls.class_id, holiday_date: Between(from, to) },
  });
  const holidaySet = new Set(holidays.map((h) => (h.holiday_date ? ymd(toLocalDate(h.holiday_date)) : '')));

  const slots = buildSlots(tt.start_time!, tt.end_time!, tt.duration!, tt.break_time ?? 0);
  if (slots.length === 0) return 0;
  const capacity = tt.max_capacity ?? cls.max_capacity ?? null;

  const rows: ClassSchedule[] = [];
  for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
    const key = ymd(d);
    if (!dowSet.has(dowCode(d))) continue;
    if (existingDates.has(key)) continue;
    if (holidaySet.has(key)) continue;
    for (const slot of slots) {
      rows.push(
        scheduleRepo.create({
          class_time_table_id: tt.class_time_table_id,
          scheduled_date: new Date(d),
          start_time: slot.start,
          end_time: slot.end,
          current_capacity: 0,
          max_capacity: capacity,
          // 시간표 강사를 회차에 복사(ullo common/schedule/rolling-schedule.generator.ts 와 같음)
          instructor_id: tt.instructor_id ?? null,
          status: 'OPEN',
          is_del: IsYn.N,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );
    }
  }

  if (rows.length > 0) {
    await scheduleRepo.save(rows, { chunk: 200 });
    log.info(`tt=${tt.class_time_table_id} → ${rows.length}건 생성`);
  }
  return rows.length;
}
