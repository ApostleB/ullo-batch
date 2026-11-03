import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * D-3 — 배치의 today()·ymd()·cron 시각(node-schedule)은 프로세스 TZ 에 의존한다. 서버 TZ 가 UTC 여도 KST 로 계산되는지 확인한다.
 * jest 안의 process.env 는 복사본이라 실제 TZ 를 못 바꾼다 → 자식 프로세스(TZ=UTC)로 검증한다.
 * 기준 시각 2026-11-03T16:00:00Z = KST 2026-11-04 01:00 (UTC 로는 아직 11-03).
 */
const ROOT = path.resolve(__dirname, '..', '..');
const INSTANT = '2026-11-03T16:00:00Z';

function runChild(imports: string[]): { ymd: string; offset: number } {
  const code = `
    ${imports.map((m) => `require(${JSON.stringify(path.join(ROOT, m))});`).join('\n')}
    const { formatLocalDateTime } = require(${JSON.stringify(path.join(ROOT, 'src/utils/date.util.ts'))});
    const d = new Date(${JSON.stringify(INSTANT)});
    console.log(JSON.stringify({ ymd: formatLocalDateTime(d), offset: d.getTimezoneOffset() }));
  `;
  const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop()!);
}

describe('[D-3] 서버 TZ 가 UTC 여도 배치는 Asia/Seoul 로 날짜·cron 을 계산한다', () => {
  it('대조군: 시간대 고정 모듈 없이 TZ=UTC 면 KST 01:00 이 UTC 날짜(11-03)로 계산된다 (문제 재현)', () => {
    const r = runChild([]);
    expect(r.offset).toBe(0);
    expect(r.ymd.slice(0, 10)).toBe('2026-11-03');
  });

  it('src/utils/timezone 을 가장 먼저 불러오면 TZ=UTC 에서도 KST(+9)로 계산된다 — 11-04 01:00', () => {
    const r = runChild(['src/utils/timezone.ts']);
    expect(r.offset).toBe(-540);
    expect(r.ymd).toBe('2026-11-04 01:00:00');
  });

  it.each(['src/index.ts', 'src/cli.ts'])('%s 의 첫 import 가 시간대 고정 모듈이다 (node-schedule·DB 보다 먼저)', (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const firstImport = src.split('\n').find((l) => l.startsWith('import '));
    expect(firstImport).toMatch(/import '\.\/utils\/timezone';/);
  });

  it('ecosystem.config.js 가 TZ=Asia/Seoul 을 프로세스 환경에 넣는다', () => {
    const eco = require(path.join(ROOT, 'ecosystem.config.js'));
    expect(eco.apps[0].env.TZ).toBe('Asia/Seoul');
  });

  it('node-schedule 의 "0 21 * * *" 다음 실행이 TZ=UTC 서버에서도 KST 21:00 이다', () => {
    const code = `
      require(${JSON.stringify(path.join(ROOT, 'src/utils/timezone.ts'))});
      const schedule = require('node-schedule');
      const job = schedule.scheduleJob('0 21 * * *', () => {});
      const next = job.nextInvocation();
      // 같은 순간을 KST 로 포맷
      console.log(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(next.toDate ? next.toDate() : next));
      console.log(new Date(next.toDate ? next.toDate() : next).getHours());
      job.cancel();
    `;
    const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', code], {
      cwd: ROOT,
      env: { ...process.env, TZ: 'UTC' },
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(out[0]).toBe('21:00');
    expect(out[1]).toBe('21');
  });
});
