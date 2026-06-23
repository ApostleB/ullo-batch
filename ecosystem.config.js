module.exports = {
  apps: [
    {
      name: 'ullo-batch',
      script: 'dist/index.js',
      instances: 1, // 배치는 반드시 단일 인스턴스 (중복 결제/정산 방지)
      autorestart: true,
      watch: false,
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
