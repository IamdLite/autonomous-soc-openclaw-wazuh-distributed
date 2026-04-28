'use strict';
// =============================================================================
// Autopilot Runtime — Distributed Edition
// Replaces the original single-node index.js with:
//   • NATS JetStream  — inter-service messaging (no localhost webhooks)
//   • Redis Sentinel  — shared case/session state (no in-memory Maps)
//   • Leader election — only one pod polls Wazuh at a time (SET NX)
//   • Circuit breakers— opossum wraps every MCP tool call
//   • Prometheus       — exposes /metrics on port 9090
// =============================================================================

const { connect, StringCodec, AckPolicy, DeliverPolicy } = require('nats');
const { createClient }   = require('redis');
const CircuitBreaker     = require('opossum');
const { WebClient }      = require('@slack/web-api');
const { App }            = require('@slack/bolt');
const promClient         = require('prom-client');
const express            = require('express');
const axios              = require('axios');
const winston            = require('winston');

// ── Logger ───────────────────────────────────────────────────────────────────
const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
  defaultMeta: { pod: process.env.POD_NAME || 'unknown' },
});

// ── Prometheus metrics ────────────────────────────────────────────────────────
promClient.collectDefaultMetrics({ prefix: 'soc_node_' });

const metrics = {
  alertsProcessed: new promClient.Counter({
    name: 'soc_alerts_processed_total',
    help: 'Total alerts ingested from Wazuh',
    labelNames: ['level', 'rule_id'],
  }),
  casesOpen: new promClient.Gauge({
    name: 'soc_cases_open_total',
    help: 'Currently open investigation cases',
  }),
  e2eLatency: new promClient.Histogram({
    name: 'soc_alert_e2e_duration_seconds',
    help: 'End-to-end alert pipeline latency',
    buckets: [1, 5, 15, 30, 60, 120, 300],
  }),
  agentDuration: new promClient.Histogram({
    name: 'soc_agent_duration_seconds',
    help: 'Per-agent processing time',
    labelNames: ['agent'],
    buckets: [0.5, 1, 5, 10, 30, 60],
  }),
  leaderElections: new promClient.Counter({
    name: 'soc_leader_election_total',
    help: 'Number of times this pod won leader election',
  }),
  circuitState: new promClient.Gauge({
    name: 'soc_circuit_breaker_state',
    help: 'Circuit breaker state: 0=CLOSED 1=OPEN 2=HALF_OPEN',
    labelNames: ['tool'],
  }),
  natsReconnects: new promClient.Counter({
    name: 'soc_nats_reconnects_total',
    help: 'NATS reconnection events',
  }),
  approvalsPending: new promClient.Gauge({
    name: 'soc_approvals_pending_total',
    help: 'Cases awaiting human approval in Slack',
  }),
};

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  natsUrl:            process.env.NATS_URL            || 'nats://nats:4222',
  redisHosts:         process.env.REDIS_SENTINEL_HOSTS || 'redis-node-0.redis-headless:26379',
  redisMaster:        process.env.REDIS_SENTINEL_MASTER|| 'soc-master',
  redisPassword:      process.env.REDIS_PASSWORD,
  mcpUrl:             process.env.MCP_SERVER_URL       || 'http://wazuh-mcp:3000/mcp',
  mcpAuthToken:       process.env.MCP_AUTH_TOKEN,
  openclawHost:       process.env.OPENCLAW_HOST        || 'http://openclaw-gateway:8888',
  llmApiKey:          process.env.LLM_API_KEY,
  llmBaseUrl:         process.env.LLM_BASE_URL         || 'https://openrouter.ai/api/v1',
  llmModel:           process.env.LLM_MODEL            || 'anthropic/claude-3.5-sonnet',
  slackAppToken:      process.env.SLACK_APP_TOKEN,
  slackBotToken:      process.env.SLACK_BOT_TOKEN,
  pollIntervalMs:     parseInt(process.env.POLL_INTERVAL_MS  || '15000'),
  maxConcurrentCases: parseInt(process.env.MAX_CONCURRENT_CASES || '20'),
  minAlertLevel:      parseInt(process.env.MIN_ALERT_LEVEL   || '7'),
  leaderLockTtlMs:    parseInt(process.env.LEADER_LOCK_TTL_MS    || '10000'),
  leaderLockRefreshMs:parseInt(process.env.LEADER_LOCK_REFRESH_MS|| '8000'),
  cbTimeoutMs:        parseInt(process.env.CB_TIMEOUT_MS           || '10000'),
  cbErrorThreshold:   parseInt(process.env.CB_ERROR_THRESHOLD_PERCENT|| '50'),
  cbResetTimeoutMs:   parseInt(process.env.CB_RESET_TIMEOUT_MS    || '30000'),
  cbVolumeThreshold:  parseInt(process.env.CB_VOLUME_THRESHOLD    || '5'),
  metricsPort:        parseInt(process.env.METRICS_PORT || '9090'),
  podName:            process.env.POD_NAME || `runtime-${Date.now()}`,
};

const LEADER_KEY    = 'soc:leader:poll-lock';
const CASE_PREFIX   = 'soc:case:';
const SESSION_PREFIX= 'soc:session:';
const APPROVAL_KEY  = 'soc:approval_queue';

// ── Global handles ────────────────────────────────────────────────────────────
let natsConn, jsMgr, redis, slackApp, slackWeb;
let isLeader = false;
let activeCases = 0;
let shutdownRequested = false;

// ── Redis Sentinel client ─────────────────────────────────────────────────────
async function connectRedis() {
  const sentinels = CONFIG.redisHosts.split(',').map(h => {
    const [host, port] = h.trim().split(':');
    return { host, port: parseInt(port) };
  });

  redis = createClient({
    socket: { reconnectStrategy: retries => Math.min(retries * 100, 3000) },
    sentinels,
    name: CONFIG.redisMaster,
    password: CONFIG.redisPassword,
  });

  redis.on('error', e => log.error('Redis error', { err: e.message }));
  redis.on('ready', () => log.info('Redis connected'));
  await redis.connect();
}

// ── NATS JetStream ────────────────────────────────────────────────────────────
async function connectNats() {
  natsConn = await connect({
    servers: CONFIG.natsUrl,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  });
  natsConn.closed().then(() => log.warn('NATS connection closed'));
  natsConn.status().then(async (status) => {
    for await (const s of status) {
      if (s.type === 'reconnect') {
        metrics.natsReconnects.inc();
        log.warn('NATS reconnected', { server: s.data });
      }
    }
  });
  jsMgr = natsConn.jetstream();
  log.info('NATS JetStream connected');
}

// ── Leader election (Redis SET NX PX) ────────────────────────────────────────
async function acquireLeader() {
  const acquired = await redis.set(
    LEADER_KEY,
    CONFIG.podName,
    { NX: true, PX: CONFIG.leaderLockTtlMs }
  );
  if (acquired && !isLeader) {
    isLeader = true;
    metrics.leaderElections.inc();
    log.info('🏆 Leader acquired — starting Wazuh poll loop', { pod: CONFIG.podName });
    startPollLoop();
  }
}

async function refreshLeader() {
  if (!isLeader) return;
  const current = await redis.get(LEADER_KEY);
  if (current !== CONFIG.podName) {
    log.warn('Lost leader lock — another pod took over', { current });
    isLeader = false;
  } else {
    await redis.pExpire(LEADER_KEY, CONFIG.leaderLockTtlMs);
  }
}

async function releaseLeader() {
  const current = await redis.get(LEADER_KEY);
  if (current === CONFIG.podName) {
    await redis.del(LEADER_KEY);
    log.info('Leader lock released on shutdown');
  }
  isLeader = false;
}

// ── Circuit breaker factory ───────────────────────────────────────────────────
function makeCB(name, fn) {
  const cb = new CircuitBreaker(fn, {
    name,
    timeout:              CONFIG.cbTimeoutMs,
    errorThresholdPercentage: CONFIG.cbErrorThreshold,
    resetTimeout:         CONFIG.cbResetTimeoutMs,
    volumeThreshold:      CONFIG.cbVolumeThreshold,
  });

  const stateVal = { CLOSED: 0, OPEN: 1, HALF_OPEN: 2 };
  const update = () => metrics.circuitState.set({ tool: name }, stateVal[cb.status.state] ?? 0);

  cb.on('open',     () => { log.warn(`CB OPEN: ${name}`);      update(); });
  cb.on('halfOpen', () => { log.info(`CB HALF_OPEN: ${name}`); update(); });
  cb.on('close',    () => { log.info(`CB CLOSED: ${name}`);    update(); });
  update();
  return cb;
}

// ── MCP tool calls (circuit-broken) ──────────────────────────────────────────
const mcpCall = makeCB('mcp-wazuh', async (tool, params) => {
  const res = await axios.post(CONFIG.mcpUrl, { tool, params }, {
    headers: {
      'Authorization': `Bearer ${CONFIG.mcpAuthToken}`,
      'Content-Type': 'application/json',
    },
    timeout: CONFIG.cbTimeoutMs,
  });
  return res.data;
});

async function callMcp(tool, params) {
  return mcpCall.fire(tool, params);
}

// ── Case state in Redis ───────────────────────────────────────────────────────
async function saveCase(caseId, data) {
  await redis.hSet(`${CASE_PREFIX}${caseId}`, {
    ...data,
    updatedAt: Date.now().toString(),
  });
  await redis.expire(`${CASE_PREFIX}${caseId}`, 48 * 3600);
}

async function getCase(caseId) {
  return redis.hGetAll(`${CASE_PREFIX}${caseId}`);
}

async function saveSession(caseId, data) {
  await redis.set(
    `${SESSION_PREFIX}${caseId}`,
    JSON.stringify(data),
    { EX: 48 * 3600 }
  );
}

async function getSession(caseId) {
  const raw = await redis.get(`${SESSION_PREFIX}${caseId}`);
  return raw ? JSON.parse(raw) : null;
}

// ── Publish to NATS (replaces POST localhost:9090/webhook) ────────────────────
const sc = StringCodec();

async function publishToAgent(agentSubject, payload) {
  await jsMgr.publish(
    `agent.tasks.${agentSubject}`,
    sc.encode(JSON.stringify(payload))
  );
}

async function publishAlert(alert) {
  await jsMgr.publish('alerts.new', sc.encode(JSON.stringify(alert)));
}

// ── Wazuh alert poll (leader-only) ───────────────────────────────────────────
async function fetchNewAlerts(lastTimestamp) {
  try {
    const result = await callMcp('search_alerts', {
      minLevel:  CONFIG.minAlertLevel,
      after:     lastTimestamp,
      limit:     100,
    });
    return result.alerts || [];
  } catch (err) {
    log.error('Alert fetch failed (circuit breaker may be open)', { err: err.message });
    return [];
  }
}

async function startPollLoop() {
  let lastTimestamp = await redis.get('soc:poll:last_timestamp') || new Date(Date.now() - 60000).toISOString();

  while (!shutdownRequested && isLeader) {
    try {
      const alerts = await fetchNewAlerts(lastTimestamp);

      for (const alert of alerts) {
        if (activeCases >= CONFIG.maxConcurrentCases) {
          log.warn('Max concurrent cases reached — queuing alert', { caseId: alert.id });
        }
        await publishAlert(alert);
        metrics.alertsProcessed.inc({ level: alert.rule?.level, rule_id: alert.rule?.id });
        lastTimestamp = alert.timestamp || lastTimestamp;
      }

      if (alerts.length > 0) {
        await redis.set('soc:poll:last_timestamp', lastTimestamp);
      }
    } catch (err) {
      log.error('Poll loop error', { err: err.message });
    }
    await sleep(CONFIG.pollIntervalMs);
  }
  log.info('Poll loop stopped (no longer leader or shutdown)');
}

// ── NATS consumer: ALERTS stream → open investigation case ───────────────────
async function startAlertConsumer() {
  const js = natsConn.jetstream();
  const consumer = await js.consumers.get('ALERTS', 'autopilot-runtime');

  for await (const msg of await consumer.consume()) {
    if (shutdownRequested) break;

    const alert = JSON.parse(sc.decode(msg.data));
    const caseId = `case-${alert.id || Date.now()}`;
    const startTime = Date.now();

    try {
      activeCases++;
      metrics.casesOpen.inc();
      log.info('New case opened', { caseId, rule: alert.rule?.description });

      await saveCase(caseId, {
        id: caseId,
        alertId: alert.id,
        status: 'TRIAGE',
        ruleId: alert.rule?.id,
        ruleLevel: alert.rule?.level,
        agentId: alert.agent?.id,
        startedAt: startTime.toString(),
      });

      await runPipeline(caseId, alert);
      msg.ack();
    } catch (err) {
      log.error('Pipeline failed', { caseId, err: err.message });
      await saveCase(caseId, { status: 'FAILED', error: err.message });
      msg.nak();
    } finally {
      activeCases--;
      metrics.casesOpen.dec();
      metrics.e2eLatency.observe((Date.now() - startTime) / 1000);
    }
  }
}

// ── 7-agent pipeline ──────────────────────────────────────────────────────────
async function runPipeline(caseId, alert) {
  const session = { caseId, alert, results: {} };

  // 1. Triage
  session.results.triage = await callAgent('triage', caseId, {
    alert,
    instruction: 'Classify severity, filter false positives, return: { verdict, severity, confidence, reasoning }',
  });
  if (session.results.triage?.verdict === 'FALSE_POSITIVE') {
    await saveCase(caseId, { status: 'CLOSED_FP' });
    log.info('Case closed as false positive', { caseId });
    return;
  }

  // 2. Correlation
  session.results.correlation = await callAgent('correlation', caseId, {
    alert,
    triage: session.results.triage,
    instruction: 'Link this alert to related events. Fetch last 50 alerts for this agent via MCP. Return: { relatedAlerts, killChainStage, attackPattern }',
  });

  // 3. Investigation (uses MCP tools)
  const agentInventory = await callMcp('get_agent_info', { agentId: alert.agent?.id }).catch(() => ({}));
  session.results.investigation = await callAgent('investigation', caseId, {
    alert,
    triage: session.results.triage,
    correlation: session.results.correlation,
    agentInfo: agentInventory,
    instruction: 'Enrich with OSINT, check VirusTotal for any IPs/hashes, assess asset criticality. Return: { iocs, riskScore, assetCriticality, enrichment }',
  });

  // 4. Response planning
  session.results.responsePlan = await callAgent('response_planner', caseId, {
    ...session.results,
    instruction: 'Generate ordered response steps with rollback conditions. Return: { steps: [{action, target, rationale, rollback}], overallRisk }',
  });

  await saveSession(caseId, session);
  await saveCase(caseId, { status: 'AWAITING_APPROVAL' });

  // 5. Slack approval (human-in-the-loop)
  const approved = await requestSlackApproval(caseId, session);
  if (!approved) {
    await saveCase(caseId, { status: 'REJECTED_BY_ANALYST' });
    log.info('Response plan rejected by analyst', { caseId });
    return;
  }

  // 6. Execution
  await saveCase(caseId, { status: 'EXECUTING' });
  session.results.execution = await callAgent('executor', caseId, {
    responsePlan: session.results.responsePlan,
    instruction: 'Execute each approved response step. Log each action and result. Return: { executed, failed, auditLog }',
  });

  // 7. Audit logging
  await callAgent('audit_logger', caseId, {
    session,
    instruction: 'Write complete case record including alert, triage, investigation, response plan, approval, and execution results.',
  });

  await saveCase(caseId, { status: 'RESOLVED', resolvedAt: Date.now().toString() });
  log.info('Case resolved', { caseId });
}

// ── Call an OpenClaw agent via NATS ──────────────────────────────────────────
async function callAgent(agentName, caseId, payload) {
  const timer = metrics.agentDuration.startTimer({ agent: agentName });
  const correlationId = `${caseId}-${agentName}-${Date.now()}`;
  const replySubject = `agent.results.${correlationId}`;

  // Publish task
  await jsMgr.publish(
    `agent.tasks.${agentName}`,
    sc.encode(JSON.stringify({ ...payload, caseId, correlationId, replySubject }))
  );

  // Wait for result on AGENT_RESULTS stream (30s timeout)
  return new Promise((resolve, reject) => {
    const sub = natsConn.subscribe(replySubject, { max: 1 });
    const timeout = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`Agent ${agentName} timed out for case ${caseId}`));
    }, 30000);

    (async () => {
      for await (const msg of sub) {
        clearTimeout(timeout);
        timer();
        resolve(JSON.parse(sc.decode(msg.data)));
      }
    })();
  });
}

// ── Slack approval gate ───────────────────────────────────────────────────────
async function requestSlackApproval(caseId, session) {
  metrics.approvalsPending.inc();
  const plan = session.results.responsePlan;

  try {
    const stepsText = (plan?.steps || [])
      .map((s, i) => `${i + 1}. *${s.action}* on \`${s.target}\`\n   _${s.rationale}_`)
      .join('\n');

    await slackWeb.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID,
      text: `🚨 *SOC Case ${caseId} — Approval Required*`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `🚨 Case ${caseId} — Action Required` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Risk:* ${plan?.overallRisk || 'MEDIUM'}\n*Kill Chain:* ${session.results.correlation?.killChainStage || 'Unknown'}\n\n*Proposed steps:*\n${stepsText}` } },
        {
          type: 'actions',
          block_id: `approval_${caseId}`,
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '✅ Approve' }, style: 'primary',  action_id: 'approve_response', value: caseId },
            { type: 'button', text: { type: 'plain_text', text: '❌ Reject'  }, style: 'danger',   action_id: 'reject_response',  value: caseId },
          ],
        },
      ],
    });

    // Store pending approval in Redis; Slack bolt handler will resolve it
    return new Promise((resolve) => {
      redis.set(`soc:approval:${caseId}`, 'PENDING', { EX: 3600 });
      const poll = setInterval(async () => {
        const decision = await redis.get(`soc:approval:${caseId}`);
        if (decision === 'APPROVED') { clearInterval(poll); resolve(true); }
        if (decision === 'REJECTED') { clearInterval(poll); resolve(false); }
      }, 2000);
    });
  } finally {
    metrics.approvalsPending.dec();
  }
}

// ── Slack bolt — handle approval buttons ─────────────────────────────────────
async function startSlackBot() {
  if (!CONFIG.slackAppToken || !CONFIG.slackBotToken) {
    log.warn('Slack tokens not set — approval gate disabled');
    return;
  }
  slackWeb = new WebClient(CONFIG.slackBotToken);
  slackApp = new App({ token: CONFIG.slackBotToken, appToken: CONFIG.slackAppToken, socketMode: true });

  slackApp.action('approve_response', async ({ ack, body, client }) => {
    await ack();
    const caseId = body.actions[0].value;
    await redis.set(`soc:approval:${caseId}`, 'APPROVED', { EX: 3600 });
    const user = body.user.name;
    log.info('Response approved via Slack', { caseId, user });
    await client.chat.postMessage({ channel: body.channel.id, text: `✅ Case ${caseId} approved by <@${body.user.id}>. Executing response...` });
  });

  slackApp.action('reject_response', async ({ ack, body, client }) => {
    await ack();
    const caseId = body.actions[0].value;
    await redis.set(`soc:approval:${caseId}`, 'REJECTED', { EX: 3600 });
    log.info('Response rejected via Slack', { caseId, user: body.user.name });
    await client.chat.postMessage({ channel: body.channel.id, text: `❌ Case ${caseId} rejected by <@${body.user.id}>.` });
  });

  await slackApp.start();
  log.info('Slack bot started (socket mode)');
}

// ── Health + metrics HTTP server ──────────────────────────────────────────────
function startHttpServer() {
  const app = express();

  app.get('/healthz', (req, res) => {
    const healthy = natsConn && !natsConn.isClosed() && redis?.isOpen;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      leader: isLeader,
      activeCases,
      pod: CONFIG.podName,
    });
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  });

  app.listen(CONFIG.metricsPort, () =>
    log.info(`Metrics/health on :${CONFIG.metricsPort}`)
  );
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  log.info(`Received ${signal} — shutting down gracefully`);
  shutdownRequested = true;
  await releaseLeader();
  await natsConn?.drain();
  await redis?.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  log.info('Autopilot Runtime starting', { pod: CONFIG.podName });

  startHttpServer();
  await connectRedis();
  await connectNats();
  await startSlackBot();

  // Leader election loop — all pods compete; only winner polls Wazuh
  setInterval(acquireLeader, CONFIG.leaderLockRefreshMs);
  setInterval(refreshLeader, CONFIG.leaderLockRefreshMs);
  await acquireLeader(); // try immediately on startup

  // All pods consume from ALERTS stream (NATS delivers to one consumer per group)
  await startAlertConsumer();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  log.error('Fatal startup error', { err: err.message, stack: err.stack });
  process.exit(1);
});
