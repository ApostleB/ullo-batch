import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { StudioClass } from './studio-class.entity';
import { ClassSchedule } from './class-schedule.entity';

/**
 * U-6 DDL(ullo docs/ddl/2026-11-18_u6_slot_on_booking.sql) 컬럼이 ullo 엔티티와 같은 정의로 배치 엔티티에도 있는지 고정한다.
 * synchronize 가 꺼져 있어 정의가 어긋나도 런타임에만 드러나므로(공통 규칙 3) 여기서 확인한다.
 */
function column(target: Function, name: string) {
  return getMetadataArgsStorage().columns.find((c) => c.target === target && c.propertyName === name);
}

describe('U-6 칸 방식 컬럼 (ullo 엔티티와 동기화)', () => {
  it('StudioClass.booking_window_days — smallint NOT NULL DEFAULT 14 (DDL #1)', () => {
    const col = column(StudioClass, 'booking_window_days');
    expect(col).toBeDefined();
    expect(col!.options.type).toBe('smallint');
    expect(col!.options.default).toBe(14);
    expect(col!.options.nullable).toBeFalsy();
  });

  it('ClassSchedule.origin_start_time — time NULL (DDL #2, 전환 기간 NULL 허용)', () => {
    const col = column(ClassSchedule, 'origin_start_time');
    expect(col).toBeDefined();
    expect(col!.options.type).toBe('time');
    expect(col!.options.nullable).toBe(true);
  });

  it("칸 키 UNIQUE 선언 — (class_time_table_id, scheduled_date, origin_start_time) WHERE is_del='N' (DDL #3)", () => {
    const idx = getMetadataArgsStorage().indices.find(
      (i) => i.target === ClassSchedule && i.name === 'ux_studio_class_schedule_slot_key',
    );
    expect(idx).toBeDefined();
    expect(idx!.columns).toEqual(['class_time_table_id', 'scheduled_date', 'origin_start_time']);
    expect(idx!.unique).toBe(true);
    expect(idx!.where).toBe(`"is_del" = 'N'`);
  });
});
