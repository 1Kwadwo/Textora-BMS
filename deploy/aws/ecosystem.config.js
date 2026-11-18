// PM2 process file for running KebSEND on a single AWS Lightsail / EC2 server.
// Both processes read secrets from /opt/kebsend/.env (dotenv). The values set
// here only pin ports and internal wiring, so they win over anything in .env.
module.exports = {
  apps: [
    {
      name: 'kebsend-web',
      script: 'web/server.js',
      cwd: '/opt/kebsend',
      env: {
        NODE_ENV: 'production',
        PORT: '4000',
        // Website forwards Paystack webhooks for bot payments to the bot,
        // which now runs on the same machine.
        BOT_WEBHOOK_URL: 'http://127.0.0.1:3000/paystack/webhook'
      },
      max_memory_restart: '400M',
      restart_delay: 3000
    },
    {
      name: 'kebsend-bot',
      script: 'index.js',
      cwd: '/opt/kebsend',
      env: {
        NODE_ENV: 'production',
        WEBHOOK_PORT: '3000'
      },
      max_memory_restart: '400M',
      restart_delay: 5000
    }
  ]
}
