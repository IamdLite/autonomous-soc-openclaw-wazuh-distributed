'use strict';
// Called by Kubernetes preStop lifecycle hook before pod terminates.
// Releases the Redis leader lock so a standby pod can take over immediately
// instead of waiting for the TTL to expire.

const { createClient } = require('redis');

const LEADER_KEY = 'soc:leader:poll-lock';
const POD_NAME   = process.env.POD_NAME || '';

async function main() {
  const sentinels = (process.env.REDIS_SENTINEL_HOSTS || 'redis-node-0.redis-headless:26379')
    .split(',').map(h => {
      const [host, port] = h.trim().split(':');
      return { host, port: parseInt(port) };
    });

  const redis = createClient({
    sentinels,
    name: process.env.REDIS_SENTINEL_MASTER || 'soc-master',
    password: process.env.REDIS_PASSWORD,
  });

  await redis.connect();

  const current = await redis.get(LEADER_KEY);
  if (current === POD_NAME) {
    await redis.del(LEADER_KEY);
    console.log(`[preStop] Leader lock released by ${POD_NAME}`);
  } else {
    console.log(`[preStop] Not leader (current: ${current}) — nothing to release`);
  }

  await redis.disconnect();
}

main().catch(err => {
  console.error('[preStop] Error releasing leader lock:', err.message);
  process.exit(0); // Don't block pod termination on error
});
