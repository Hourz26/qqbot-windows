// PM2 配置：托管 SnowLuma（QQ OneBot 桥接服务）
// 用法：
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2-windows-startup install   (登录自启)
module.exports = {
  apps: [
    {
      name: 'snowluma',
      script: 'index.mjs',
      cwd: 'C:\\Apps\\snowluma',
      interpreter: 'node',
      autorestart: true,
      max_restarts: 30,
      min_uptime: '20s',
      restart_delay: 3000,
      kill_timeout: 10000,
      watch: false,
      time: true,
      merge_logs: true,
      out_file: 'C:\\Apps\\snowluma\\logs\\pm2-out.log',
      error_file: 'C:\\Apps\\snowluma\\logs\\pm2-err.log',
    },
    {
      name: 'qq-bridge',
      script: 'bridge.mjs',
      cwd: 'C:\\Apps\\snowluma',
      interpreter: 'node',
      autorestart: true,
      max_restarts: 50,
      min_uptime: '20s',
      restart_delay: 5000,
      kill_timeout: 8000,
      watch: false,
      time: true,
      merge_logs: true,
      out_file: 'C:\\Apps\\snowluma\\logs\\bridge-out.log',
      error_file: 'C:\\Apps\\snowluma\\logs\\bridge-err.log',
    },
  ],
};
