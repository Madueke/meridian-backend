module.exports = {
  apps: [
    {
      name: 'meridian-backend',
      script: 'server.js',
      cwd: '/home/ubuntu/meridian-backend',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        MT5_BACKEND_URL: 'http://18.171.248.83:8643',
        MT5_BRIDGE_MODE: 'metaquotes',
        MT5_BRIDGE_PORT: '8643',
      },
    },
    {
      name: 'mt5-bridge',
      script: 'bridge/server.js',
      cwd: '/home/ubuntu/meridian-backend',
      env: {
        NODE_ENV: 'production',
        MT5_BRIDGE_PORT: '8643',
        MT5_BRIDGE_MODE: 'metaquotes',
        MT5_BACKEND_URL: 'http://18.171.248.83:8643',
      },
    },
  ],
};
