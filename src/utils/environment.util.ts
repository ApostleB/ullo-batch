/**
 * 운영 판단 기준 (N-9) — NODE_ENV 가 "명시적 비운영 값"이 아니면 운영으로 본다.
 * 미주입(undefined)·빈 값·오타·staging 등 알 수 없는 값은 모두 운영 쪽이다(fail-closed).
 * 이 머신들의 .env / PM2 설정에 NODE_ENV 가 없어도 방어가 풀리지 않게 하려는 규칙이다.
 * 로컬 개발·테스트 DB 연동은 NODE_ENV=local 처럼 비운영 값을 명시해서 쓴다.
 */
const NON_PRODUCTION_ENVS: readonly string[] = ['local', 'development', 'dev', 'test'];

export function isExplicitNonProduction(nodeEnv: string | undefined | null): boolean {
  return NON_PRODUCTION_ENVS.includes(String(nodeEnv ?? '').trim().toLowerCase());
}
