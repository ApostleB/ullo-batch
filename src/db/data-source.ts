import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { MemberPlan } from '../entities/member-plan.entity';
import { MemberBilling } from '../entities/member-billing.entity';
import { Plan } from '../entities/plan.entity';
import { MemberCredit } from '../entities/member-credit.entity';
import { MemberCreditLog } from '../entities/member-credit-log.entity';
import { Payment } from '../entities/payment.entity';
import { Studio } from '../entities/studio.entity';
import { StudioClass } from '../entities/studio-class.entity';
import { ClassTimeTable } from '../entities/class-time-table.entity';
import { ClassSchedule } from '../entities/class-schedule.entity';
import { ClassRepeatDay } from '../entities/class-repeat-day.entity';
import { ClassHoliday } from '../entities/class-holiday.entity';
import { MemberClassSession } from '../entities/member-class-session.entity';
import { Settlement } from '../entities/settlement.entity';
import { SettlementPolicy } from '../entities/settlement-policy.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: config.db.host,
  port: config.db.port,
  username: config.db.username,
  password: config.db.password,
  database: config.db.database,
  synchronize: false,
  logging: false,
  entities: [
    MemberPlan,
    MemberBilling,
    Plan,
    MemberCredit,
    MemberCreditLog,
    Payment,
    Studio,
    StudioClass,
    ClassTimeTable,
    ClassSchedule,
    ClassRepeatDay,
    ClassHoliday,
    MemberClassSession,
    Settlement,
    SettlementPolicy,
  ],
});
