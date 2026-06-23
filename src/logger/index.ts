import path from 'path';
import winston from 'winston';
import { config } from '../config';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, job, runId, ...meta }) => {
  const tag = job ? `[${job}${runId ? `:${runId}` : ''}]` : '';
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level} ${tag} ${message}${extra}`;
});

export const logger = winston.createLogger({
  level: config.log.level,
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), logFormat),
  transports: [
    new winston.transports.Console({ format: combine(colorize(), logFormat) }),
    new winston.transports.File({ filename: path.join(config.log.dir, 'batch.log') }),
    new winston.transports.File({ filename: path.join(config.log.dir, 'error.log'), level: 'error' }),
  ],
});

/** 잡 단위 로거 (job 이름 + runId 태그 자동 부착) */
export function createJobLogger(job: string, runId: string) {
  return logger.child({ job, runId });
}
