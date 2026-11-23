module.exports = {
  apps: [
    {
      name: 'kebsend-web',
      script: 'web/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        WEB_PORT: 4000,
        BOT_WEBHOOK_URL: 'http://127.0.0.1:3000/paystack/webhook'
      }
    },
    {
      name: 'kebsend-bot',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        WEBHOOK_PORT: 3000
      }
    }
  ]
};
