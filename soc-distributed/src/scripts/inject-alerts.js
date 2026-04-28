'use strict';
// =============================================================================
// Synthetic Alert Injector
// Publishes fake Wazuh alerts directly to the ALERTS NATS stream.
// Used for: benchmarks, HPA scaling demos, circuit breaker tests.
//
// Usage:
//   node inject-alerts.js --count 200 --rate 50
//   node inject-alerts.js --count 500 --rate 100 --level 10
// =============================================================================

const { connect, StringCodec } = require('nats');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
    .map(([k, v]) => [k, v ?? true])
);

// Also support --key value style
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--') && !process.argv[i].includes('=') && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
}

const COUNT = parseInt(args.count || '50');
const RATE  = parseInt(args.rate  || '10');   // alerts per minute
const LEVEL = parseInt(args.level || '8');
const NATS_URL = process.env.NATS_URL || 'nats://nats:4222';

const RULE_TEMPLATES = [
  { id: '5710', description: 'SSH brute force attack', groups: ['authentication_failed', 'ssh'] },
  { id: '5503', description: 'PAM: User login failed', groups: ['authentication_failed', 'pam'] },
  { id: '553',  description: 'File integrity monitoring: checksum changed', groups: ['ossec', 'fim'] },
  { id: '87105',description: 'Mimikatz credential dumping detected', groups: ['windows', 'credential_access'] },
  { id: '31168',description: 'Web attack - SQL injection attempt', groups: ['web', 'attack', 'injection'] },
  { id: '40112',description: 'Lateral movement - SMB share enumeration', groups: ['windows', 'lateral_movement'] },
  { id: '92205',description: 'Data exfiltration - large outbound transfer', groups: ['network', 'exfiltration'] },
];

function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomIp()       { return `${randInt(10,200)}.${randInt(1,254)}.${randInt(1,254)}.${randInt(1,254)}`; }
function randInt(min,max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function makeAlert(index) {
  const rule = randomItem(RULE_TEMPLATES);
  const ts = new Date(Date.now() - randInt(0, 60000)).toISOString();
  return {
    id:        `synth-${Date.now()}-${index}`,
    timestamp: ts,
    rule: {
      id:          rule.id,
      level:       LEVEL + randInt(0, 7 - LEVEL > 0 ? 0 : 15 - LEVEL),
      description: rule.description,
      groups:      rule.groups,
    },
    agent: {
      id:   `00${randInt(1, 20)}`,
      name: `agent-${randomItem(['web-server', 'db-server', 'dc-01', 'workstation', 'gateway'])}`,
      ip:   randomIp(),
    },
    data: {
      srcip:  randomIp(),
      dstip:  randomIp(),
      srcport: randInt(1024, 65535).toString(),
      dstport: randomItem(['22', '445', '3389', '80', '443', '8080']),
    },
    _synthetic: true,
  };
}

async function main() {
  console.log(`[injector] Connecting to NATS at ${NATS_URL}`);
  const nc  = await connect({ servers: NATS_URL });
  const js  = nc.jetstream();
  const sc  = StringCodec();
  const delayMs = Math.round(60000 / RATE);

  console.log(`[injector] Injecting ${COUNT} alerts at ~${RATE}/min (${delayMs}ms interval)`);
  console.log(`[injector] Alert level: ${LEVEL}+`);
  console.log('');

  let sent = 0;
  const start = Date.now();

  for (let i = 0; i < COUNT; i++) {
    const alert = makeAlert(i);
    await js.publish('alerts.new', sc.encode(JSON.stringify(alert)));
    sent++;
    process.stdout.write(`\r[injector] Sent ${sent}/${COUNT} alerts (${alert.rule.description.slice(0, 40)}...)`);
    if (i < COUNT - 1) await sleep(delayMs);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n[injector] Done — ${sent} alerts injected in ${elapsed}s`);
  console.log(`[injector] Actual rate: ${(sent / (elapsed / 60)).toFixed(1)} alerts/min`);
  console.log('[injector] Watch HPA: kubectl get hpa -n soc-system --watch');

  await nc.drain();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error('[injector] Fatal:', err.message);
  process.exit(1);
});
