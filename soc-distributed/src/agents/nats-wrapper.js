'use strict';
// =============================================================================
// OpenClaw Agent NATS Wrapper
// Thin adapter that:
//   1. Subscribes to its agent.tasks.<name> NATS subject
//   2. Forwards the payload to the local OpenClaw gateway (webhook unchanged)
//   3. Publishes the result back on the replySubject in AGENT_RESULTS
//
// Deploy one instance per agent type. Set AGENT_NAME env var.
// This keeps OpenClaw internals completely unchanged.
// =============================================================================

const { connect, StringCodec } = require('nats');
const axios  = require('axios');
const winston = require('winston');
const express = require('express');
const promClient = require('prom-client');

const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
  defaultMeta: { agent: process.env.AGENT_NAME },
});

promClient.collectDefaultMetrics({ prefix: 'agent_node_' });

const tasksHandled = new promClient.Counter({
  name: 'agent_tasks_handled_total',
  help: 'Tasks handled by this agent wrapper',
  labelNames: ['agent', 'status'],
});
const taskLatency = new promClient.Histogram({
  name: 'agent_task_duration_seconds',
  help: 'Agent task processing time',
  labelNames: ['agent'],
  buckets: [0.5, 1, 5, 10, 30, 60],
});

const CONFIG = {
  agentName:      process.env.AGENT_NAME        || 'triage',
  natsUrl:        process.env.NATS_URL           || 'nats://nats:4222',
  openclawUrl:    process.env.OPENCLAW_HOST      || 'http://openclaw-gateway:8888',
  openclawApiKey: process.env.LLM_API_KEY,
  llmBaseUrl:     process.env.LLM_BASE_URL       || 'https://openrouter.ai/api/v1',
  llmModel:       process.env.LLM_MODEL          || 'anthropic/claude-3.5-sonnet',
  metricsPort:    parseInt(process.env.METRICS_PORT || '9091'),
  concurrency:    parseInt(process.env.AGENT_CONCURRENCY || '5'),
};

const sc = StringCodec();
let natsConn;
let inFlight = 0;

// ── Connect to NATS ───────────────────────────────────────────────────────────
async function connectNats() {
  natsConn = await connect({
    servers: CONFIG.natsUrl,
    reconnect: true,
    maxReconnectAttempts: -1,
  });
  log.info('NATS connected', { agent: CONFIG.agentName });
}

// ── Forward to OpenClaw gateway ───────────────────────────────────────────────
async function forwardToOpenClaw(payload) {
  // OpenClaw gateway webhook endpoint — unchanged from single-node design
  // We're only changing *how* the payload arrives (NATS vs localhost HTTP)
  const response = await axios.post(
    `${CONFIG.openclawUrl}/webhook/${CONFIG.agentName}`,
    {
      ...payload,
      llm: {
        baseUrl: CONFIG.llmBaseUrl,
        apiKey:  CONFIG.openclawApiKey,
        model:   CONFIG.llmModel,
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    }
  );
  return response.data;
}

// ── NATS consumer loop ────────────────────────────────────────────────────────
async function startConsumer() {
  const js = natsConn.jetstream();
  const subject = `agent.tasks.${CONFIG.agentName}`;

  // Durable consumer — survives pod restarts; JetStream re-delivers unacked msgs
  const consumer = await js.consumers.get('AGENT_TASKS', `${CONFIG.agentName}-consumer`);

  log.info(`Consuming from agent.tasks.${CONFIG.agentName}`);

  for await (const msg of await consumer.consume({ max_messages: CONFIG.concurrency })) {
    if (inFlight >= CONFIG.concurrency) {
      // Back-pressure: nack and re-queue after delay
      msg.nak(5000);
      continue;
    }

    inFlight++;
    const timer = taskLatency.startTimer({ agent: CONFIG.agentName });

    // Process without blocking consumer loop
    handleTask(msg, timer).finally(() => { inFlight--; });
  }
}

async function handleTask(msg, timer) {
  let payload;
  try {
    payload = JSON.parse(sc.decode(msg.data));
    log.info('Task received', { caseId: payload.caseId, agent: CONFIG.agentName });

    const result = await forwardToOpenClaw(payload);

    // Publish result back so runtime can receive it
    if (payload.replySubject) {
      await natsConn.publish(
        payload.replySubject,
        sc.encode(JSON.stringify({ success: true, agent: CONFIG.agentName, result }))
      );
    }

    msg.ack();
    tasksHandled.inc({ agent: CONFIG.agentName, status: 'success' });
    log.info('Task completed', { caseId: payload.caseId, agent: CONFIG.agentName });
  } catch (err) {
    log.error('Task failed', { caseId: payload?.caseId, agent: CONFIG.agentName, err: err.message });
    tasksHandled.inc({ agent: CONFIG.agentName, status: 'error' });

    // Publish error result so runtime doesn't hang waiting
    if (payload?.replySubject) {
      await natsConn.publish(
        payload.replySubject,
        sc.encode(JSON.stringify({ success: false, agent: CONFIG.agentName, error: err.message }))
      ).catch(() => {});
    }
    msg.nak(); // JetStream will re-deliver
  } finally {
    timer();
  }
}

// ── Health + metrics ──────────────────────────────────────────────────────────
function startHttpServer() {
  const app = express();
  app.get('/healthz', (req, res) => res.json({ status: 'ok', agent: CONFIG.agentName, inFlight }));
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  });
  app.listen(CONFIG.metricsPort, () => log.info(`Metrics on :${CONFIG.metricsPort}`));
}

async function main() {
  log.info('Agent NATS wrapper starting', { agent: CONFIG.agentName });
  startHttpServer();
  await connectNats();
  await startConsumer();
}

main().catch(err => {
  log.error('Fatal', { err: err.message });
  process.exit(1);
});
