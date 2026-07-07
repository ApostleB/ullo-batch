-- member_billing PG 구분 컬럼 (토스 → KG이니시스 자동결제 마이그레이션)
-- synchronize:false 이므로 수동 DDL. subscription-billing 잡을 재활성화하기 전에 반드시 적용할 것.
-- (엔티티: src/entities/member-billing.entity.ts 의 provider 컬럼과 대응)

ALTER TABLE member_billing ADD COLUMN IF NOT EXISTS provider text;

-- 기존 빌링키는 전부 토스 발급분이므로 TOSS로 백필. (NULL도 잡에서는 토스로 취급하지만 명시적으로 채워둔다)
UPDATE member_billing SET provider = 'TOSS' WHERE provider IS NULL;

-- ⚠️ 남은 조치(배치 저장소 밖):
--   1) ullo(백엔드)의 이니시스 빌링키 발급 로직(billing.service.ts handleIssueReturn 등)이
--      신규 발급 행에 provider='INICIS'를 채우도록 수정해야 배치가 올바르게 이니시스로 청구한다.
--   2) ullo 쪽 member_billing 엔티티에도 동일 provider 컬럼 추가.
--   위 두 가지가 되기 전에는 신규 이니시스 카드도 provider=NULL/TOSS로 남아 토스로 청구 → 실패.
