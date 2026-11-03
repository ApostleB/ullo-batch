/**
 * 프로세스 시간대를 Asia/Seoul 로 고정한다 [D-3].
 *
 * today()·ymd()·cron 시각(node-schedule: "21:00 청구" 등)은 모두 프로세스 로컬 시간으로 계산하므로
 * 서버 TZ 가 UTC 면 청구가 KST 06:00 에 돌고 결제일이 DB(Asia/Seoul)의 CURRENT_DATE 와 하루 어긋난다.
 *
 * index.ts·cli.ts 의 **첫 import** 여야 한다 — node-schedule 등 다른 모듈이 Date 를 쓰기 전에 고정해야 한다.
 * (Node 는 process.env.TZ 대입 시 시간대 캐시를 즉시 갱신한다. ecosystem.config.js 의 env.TZ 와 함께 이중으로 고정한다.)
 * 백엔드 복제본: src/common/timezone.ts
 */
export const APP_TIMEZONE = 'Asia/Seoul';
process.env.TZ = APP_TIMEZONE;
