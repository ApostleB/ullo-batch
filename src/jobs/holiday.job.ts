import { Between } from 'typeorm';
import { AppDataSource } from '../db/data-source';
import { Holiday } from '../entities/holiday.entity';
import { config } from '../config';
import { fetchHolidays, HolidayApiItem } from '../utils/holiday-api.client';
import { createJobLogger } from '../logger';

export const JOB_NAME = 'holiday';

type Log = ReturnType<typeof createJobLogger>;

/** 변경 검증 대상 필드가 하나라도 다르면 true */
function isChanged(row: Holiday, item: HolidayApiItem): boolean {
  return (
    row.date_name !== item.dateName ||
    row.is_holiday !== item.isHoliday ||
    (row.date_kind ?? null) !== (item.dateKind ?? null)
  );
}

/**
 * 공휴일 동기화 — 매월 실행.
 * 현재 월부터 HOLIDAY_HORIZON_MONTHS(기본 3)개월치를 API로 조회하여
 * 신규는 insert, 기존은 변경분만 update, 동일하면 skip.
 */
export async function execute(log: Log): Promise<void> {
  const horizon = config.params.holidayHorizonMonths;
  const now = new Date();

  // 1) 대상 월 목록 (현재 월 + 이후 horizon-1개월)
  const months = Array.from({ length: horizon }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  log.info(
    `공휴일 동기화 대상: ${months.map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`).join(', ')}`,
  );

  // 2) API 조회 (월별) → (locdate, seq) 기준 병합(dedup).
  //    같은 키가 중복되면 뒤 값으로 덮는다. (dedup 없이 두면 둘 다 insert로 분류돼 유니크 제약 위반 크래시)
  const mergedMap = new Map<string, HolidayApiItem>();
  for (const { year, month } of months) {
    const items = await fetchHolidays(year, month);
    for (const item of items) mergedMap.set(`${item.locdate}_${item.seq}`, item);
  }
  const apiItems: HolidayApiItem[] = [...mergedMap.values()];
  if (apiItems.length === 0) {
    log.info('API 공휴일 결과 없음 — 종료');
    return;
  }

  // 3) 대상 기간의 기존 데이터 조회 (locdate 범위)
  const repo = AppDataSource.getRepository(Holiday);
  const locdates = apiItems.map((i) => i.locdate);
  const minLoc = Math.min(...locdates);
  const maxLoc = Math.max(...locdates);
  const existing = await repo.find({ where: { locdate: Between(minLoc, maxLoc) } });
  const existingMap = new Map(existing.map((r) => [`${r.locdate}_${r.seq}`, r]));

  // 4) 분기: insert / update / skip
  const toInsert: Holiday[] = [];
  const toUpdate: Holiday[] = [];
  for (const item of apiItems) {
    const key = `${item.locdate}_${item.seq}`;
    const row = existingMap.get(key);

    if (!row) {
      toInsert.push(
        repo.create({
          locdate: item.locdate,
          seq: item.seq,
          date_name: item.dateName,
          is_holiday: item.isHoliday,
          date_kind: item.dateKind ?? null,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );
    } else if (isChanged(row, item)) {
      row.date_name = item.dateName;
      row.is_holiday = item.isHoliday;
      row.date_kind = item.dateKind ?? null;
      row.updated_at = new Date();
      toUpdate.push(row);
    }
  }

  // 5) 저장
  if (toInsert.length > 0) await repo.save(toInsert, { chunk: 100 });
  if (toUpdate.length > 0) await repo.save(toUpdate, { chunk: 100 });

  log.info(
    `공휴일 동기화 완료: 조회 ${apiItems.length} / insert ${toInsert.length} / update ${toUpdate.length} / skip ${apiItems.length - toInsert.length - toUpdate.length}`,
  );
}
