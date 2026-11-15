import { existingTables, EXISTING_TABLES_SQL } from './table-exists.util';

describe('existingTables', () => {
  it('to_regclass 로 확인하고 있는 이름만 돌려준다(structured result)', async () => {
    const q = { query: jest.fn().mockResolvedValue({ records: [{ name: 'a' }] }) };

    const got = await existingTables(q, ['a', 'b']);

    expect([...got]).toEqual(['a']);
    expect(q.query).toHaveBeenCalledWith(EXISTING_TABLES_SQL, [['a', 'b']], true);
    expect(EXISTING_TABLES_SQL).toContain('to_regclass(name) IS NOT NULL');
  });

  it('records 가 없으면 빈 집합이다', async () => {
    const q = { query: jest.fn().mockResolvedValue({}) };
    expect((await existingTables(q, ['a'])).size).toBe(0);
  });
});
