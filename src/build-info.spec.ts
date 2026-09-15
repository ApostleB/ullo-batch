import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readBuildInfo } from './build-info';

/**
 * 배포 확인용 값이라 **없거나 깨져도 던지면 안 된다.**
 * 배치는 기동 실패가 곧 정산·롤링 중단이므로 이 경로에서 예외가 새면 안 된다.
 */
describe('readBuildInfo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-build-info-'));
  const unknown = { commit: 'unknown', ref: 'unknown', run_id: 'unknown', built_at: 'unknown' };

  it('파일이 없으면 unknown 을 돌려준다', () => {
    expect(readBuildInfo([join(dir, 'none.json')])).toEqual(unknown);
  });

  it('정상 파일을 그대로 읽는다', () => {
    const path = join(dir, 'ok.json');
    const info = { commit: 'abc123', ref: 'dev', run_id: '42', built_at: '2026-09-15T05:00:00Z' };
    writeFileSync(path, JSON.stringify(info));
    expect(readBuildInfo([path])).toEqual(info);
  });

  it('JSON 이 깨져 있어도 던지지 않는다', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json');
    expect(readBuildInfo([path])).toEqual(unknown);
  });

  it('일부 필드만 있으면 나머지는 unknown 으로 채운다', () => {
    const path = join(dir, 'partial.json');
    writeFileSync(path, JSON.stringify({ commit: 'abc' }));
    expect(readBuildInfo([path])).toEqual({ ...unknown, commit: 'abc' });
  });

  it('앞 경로가 없으면 다음 후보 경로를 본다', () => {
    const path = join(dir, 'second.json');
    writeFileSync(path, JSON.stringify({ commit: 'second' }));
    expect(readBuildInfo([join(dir, 'missing.json'), path]).commit).toBe('second');
  });
});
