import { readFileSync } from 'fs';
import { join } from 'path';

/** 배포 시 기록되는 빌드 정보 */
export interface BuildInfo {
  commit: string;
  ref: string;
  run_id: string;
  built_at: string;
}

const UNKNOWN: BuildInfo = { commit: 'unknown', ref: 'unknown', run_id: 'unknown', built_at: 'unknown' };

/**
 * 배포 워크플로가 저장소 루트에 남기는 `build-info.json` 을 읽는다.
 *
 * 배치는 HTTP 서버가 없어 API 처럼 엔드포인트로 노출할 수 없다.
 * 대신 **시작 로그에 찍고**, 배포 검증은 서버의 이 파일을 직접 읽어 확인한다.
 * 파일이 없거나 깨져 있으면 unknown 을 돌려준다 — 확인용 값이라 기동을 막으면 안 된다.
 */
export function readBuildInfo(paths: string[] = defaultPaths()): BuildInfo {
  for (const path of paths) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildInfo>;
      return { ...UNKNOWN, ...parsed };
    } catch {
      // 다음 후보 경로를 본다
    }
  }
  return UNKNOWN;
}

function defaultPaths(): string[] {
  // dist/build-info.js 기준 ../ = 저장소 루트
  return [join(process.cwd(), 'build-info.json'), join(__dirname, '..', 'build-info.json')];
}
