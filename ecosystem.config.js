module.exports = {
  apps: [
    {
      name: 'ullo-batch',
      script: 'dist/index.js',
      instances: 1, // 배치는 반드시 단일 인스턴스 (중복 결제/정산 방지)
      autorestart: true,
      watch: false,
      // 시간대 고정 [D-3] — cron(21:00 청구 등)·today() 가 프로세스 TZ 에 의존한다. index.ts 첫 import 에서도 한 번 더 고정한다.
      // (--env local|prod 와 병합되는 공통 env)
      env: { TZ: 'Asia/Seoul' },
      env_local: { NODE_ENV: 'local' },
      env_prod: { NODE_ENV: 'prod' },
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_restarts: 5,
      min_uptime: '10s',
      restart_delay: 3000,
      kill_timeout: 10000,
      listen_timeout: 5000,
    },
  ],
};
