-- 탈퇴 회원 분리보관 테이블
-- 탈퇴 시 라이브 member 의 개인정보는 즉시 익명화하고, 파기 전까지의 개인정보
-- 스냅샷을 이 테이블에 분리보관한다. purge_at 경과 시 배치(ullo-batch)가 최종 파기.
-- (synchronize:false — 이 DDL을 운영/개발 DB에 수동 적용해야 엔티티가 동작함)

CREATE TABLE IF NOT EXISTS member_withdrawal (
    member_withdrawal_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id            uuid        NOT NULL,
    member_email         text,
    member_name          text,
    member_nickname      text,
    member_mobile        text,
    gender               text,
    provider_ref         text,               -- 예: 'KAKAO:1234567'
    withdraw_reason      text,
    withdrawn_at         timestamp   NOT NULL,
    purge_at             timestamp   NOT NULL, -- 탈퇴 + 보관기간(기본 30일)
    is_purged            is_yn       NOT NULL DEFAULT 'N',
    purged_at            timestamp,
    created_at           timestamp   NOT NULL DEFAULT now()
);

-- 배치가 파기 대상(미파기 + 기한 경과)을 훑는 인덱스
CREATE INDEX IF NOT EXISTS member_withdrawal_purge_idx
    ON member_withdrawal (is_purged, purge_at);

-- 회원별 조회용
CREATE INDEX IF NOT EXISTS member_withdrawal_member_idx
    ON member_withdrawal (member_id);
