/**
 * 테이블 존재 확인 — DDL 적용 전에 배포돼도 잡이 테이블 없음 오류로 트랜잭션을 깨뜨리지 않게 먼저 확인한다(W10f).
 *
 * `to_regclass(name)` 는 없는 이름이면 오류 없이 NULL 을 돌려준다(search_path 기준).
 * 그래서 트랜잭션 안에서 불러도 트랜잭션이 abort 되지 않는다.
 */
export interface StructuredQuery {
  query(sql: string, params: unknown[], useStructuredResult: true): Promise<{ records?: unknown[]; affected?: number }>;
}

export const EXISTING_TABLES_SQL = `SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL`;

/** names 중 지금 DB 에 있는 테이블 이름 집합 */
export async function existingTables(q: StructuredQuery, names: readonly string[]): Promise<Set<string>> {
  const res = await q.query(EXISTING_TABLES_SQL, [[...names]], true);
  const rows = (res?.records ?? []) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}
