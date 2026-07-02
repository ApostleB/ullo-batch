-- 공휴일 캐시 테이블 (synchronize: false 이므로 수동 DDL)
CREATE TABLE IF NOT EXISTS holiday (
  holiday_id  uuid        NOT NULL DEFAULT gen_random_uuid(),
  locdate     integer     NOT NULL,
  seq         integer     NOT NULL DEFAULT 1,
  date_name   text        NOT NULL,
  is_holiday  varchar(1)  NOT NULL,
  date_kind   varchar(2)  NULL,
  created_at  timestamp   NULL,
  updated_at  timestamp   NULL,
  CONSTRAINT holiday_pk PRIMARY KEY (holiday_id),
  CONSTRAINT holiday_locdate_seq_uk UNIQUE (locdate, seq)
);

CREATE INDEX IF NOT EXISTS holiday_locdate_idx ON holiday (locdate);
