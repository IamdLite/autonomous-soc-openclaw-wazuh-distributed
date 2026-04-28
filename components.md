# Autonomous SOC — Distributed Architecture: Component Reference

> This document describes the role of every component in the
> Wazuh-OpenClaw-Autopilot distributed stack. Each entry covers what the
> component does, why it exists, and what breaks if it goes down.

---

## 1. Wazuh Manager (master node)

**Role:** The detection engine and cluster coordinator.

Wazuh collects raw events from agents installed on monitored endpoints —
file integrity changes, failed logins, suspicious process execution, network
anomalies — and runs them through a library of XML rules to produce structured
alerts with a severity level (0–15). The master node handles rule processing,
coordinates the two worker nodes over port 1516, and exposes the REST API on
port 55000 that the MCP server queries.

**What breaks without it:** No alerts are generated. The entire pipeline stops
at the source.

---

## 2. Wazuh Worker Nodes (×2)

**Role:** Agent event ingestion at scale.

Workers receive raw syslog and agent heartbeats from monitored endpoints,
pre-process events, and forward them to the master for rule matching.
Running two workers means agent connections are distributed and a single
node failure does not interrupt event collection.

**What breaks without them:** Alert throughput drops; agents connected only to
a failed worker stop reporting until they re-register with another node.

---

## 3. OpenSearch (3-node cluster)

**Role:** Alert index and long-term storage.

Every alert the Wazuh manager generates is indexed into OpenSearch. The
Autopilot runtime polls this index to discover new alerts. The Investigation
agent also queries it for historical context — e.g. "how many times has this
source IP appeared in the last 7 days?"

**What breaks without it:** New alerts cannot be discovered by the runtime.
Investigation queries lose historical context, degrading enrichment quality.

---

## 4. Wazuh MCP Server (×2 replicas)

**Role:** Tool-calling bridge between AI agents and Wazuh.

The Model Context Protocol (MCP) server exposes Wazuh's REST API as
structured tool definitions that OpenClaw agents can call mid-investigation:
`search_alerts`, `get_agent_info`, `get_agent_processes`, `run_active_response`.
Without this layer, AI agents would have no programmatic way to query live
Wazuh data — they would reason only on the initial alert payload.

Every call from the runtime to the MCP server is wrapped in an **opossum
circuit breaker**. If the MCP server becomes slow or unavailable, the breaker
opens (fails fast) rather than letting the failure cascade through every
in-flight investigation.

**What breaks without it:** Agents cannot query Wazuh during investigation.
The circuit breaker prevents this failure from stalling all cases.

---

## 5. OpenClaw

**Role:** AI agent framework powering the 7-stage pipeline.

OpenClaw provides the scaffold for defining agents with goals, tools, and
memory. Each of the seven pipeline stages is an OpenClaw agent. The framework
handles prompt construction, tool dispatch, result parsing, and retry logic so
the pipeline logic focuses on *what* to do, not *how* to call the LLM.

**The 7 agents in pipeline order:**

| # | Agent | Responsibility |
|---|-------|----------------|
| 1 | **Triage** | Classify severity, filter false positives, assign confidence score |
| 2 | **Correlation** | Link this alert to related events; map kill-chain stage |
| 3 | **Investigation** | OSINT enrichment, VirusTotal lookups, asset criticality assessment |
| 4 | **Response Planner** | Generate ordered remediation steps with rollback conditions |
| 5 | **Slack Notifier** | Post investigation summary and proposed plan to approval channel |
| 6 | **Executor** | Run approved response steps via Wazuh active response |
| 7 | **Audit Logger** | Write complete case record: alert → reasoning → decision → outcome |

**What breaks without it:** The reasoning layer disappears. Wazuh alerts
arrive but no triage, correlation, or response planning occurs.

---

## 6. Autopilot Runtime (3 replicas, HPA)

**Role:** Pipeline orchestrator and case state machine.

The runtime is the central coordinator. It:
- Polls Wazuh (leader pod only) for new alerts via the MCP server
- Opens a case in Redis for each alert above the threshold
- Drives the alert through all 7 agent stages in sequence via NATS messages
- Manages the Slack approval gate before execution
- Exposes `/metrics` and `/healthz` for observability and Kubernetes probes

Three replicas run simultaneously. **Only the leader pod polls Wazuh** —
determined by a Redis `SET NX` lock with a 10-second TTL and 8-second refresh.
If the leader pod dies, the lock expires and a standby pod acquires it within
seconds. All replicas share case state via Redis, so any pod can handle any
alert regardless of which pod started it.

**What breaks without it:** No orchestration. Alerts are detected by Wazuh
but never investigated or acted upon.

---

## 7. NATS JetStream (3-node cluster)

**Role:** Durable message queue replacing localhost webhooks.

In the original single-node design, the runtime called agents via
`POST localhost:9090/webhook` — a pattern that physically prevents
multi-host deployment. NATS JetStream replaces these calls with four
persistent streams:

| Stream | Direction | Purpose |
|--------|-----------|---------|
| `ALERTS` | Wazuh → Runtime | New alert delivery |
| `AGENT_TASKS` | Runtime → Agents | Per-agent task dispatch |
| `AGENT_RESULTS` | Agents → Runtime | Agent output collection |
| `APPROVALS` | Runtime → Slack | Human decision events |

JetStream's **at-least-once delivery with acknowledgement** means that if a
pod crashes mid-investigation, the unacked message is re-delivered to another
pod automatically. No alerts are silently dropped.

**What breaks without it:** Inter-service communication fails entirely. The
runtime cannot dispatch tasks to agents or receive results.

---

## 8. Redis Sentinel (1 primary + 2 replicas)

**Role:** Shared state store enabling horizontal scaling.

The original runtime held all case state in JavaScript `Map` objects in
process memory. This is destroyed on every restart and cannot be shared across
multiple pods. Redis replaces this with a persistent, network-accessible store:

| Key pattern | Contains |
|-------------|----------|
| `soc:case:{id}` | Case metadata, status, timestamps |
| `soc:session:{id}` | Full pipeline context per case |
| `soc:approval:{id}` | Human decision (PENDING / APPROVED / REJECTED) |
| `soc:leader:poll-lock` | Leader election lock (SET NX, 10s TTL) |
| `soc:poll:last_timestamp` | Wazuh poll cursor (prevents re-processing) |

Sentinel mode provides automatic failover: if the primary Redis node dies,
a replica is promoted to primary within seconds and the runtime reconnects
transparently.

**What breaks without it:** Case state is lost on any pod restart. Leader
election breaks. Approval decisions cannot be communicated between pods.

---

## 9. LLM Backend (OpenAI / Anthropic / Ollama)

**Role:** Reasoning engine for all OpenClaw agents.

Each agent sends a structured prompt — containing the alert data, tool results,
and task instruction — to the LLM and receives back a structured decision
(triage verdict, correlation hypothesis, response plan). The LLM is stateless;
all context is assembled and injected by the runtime per call.

Supported backends (configured via `LLM_BASE_URL` and `LLM_MODEL`):
- **OpenRouter** (recommended) — access to Claude, GPT-4, Llama via one key
- **OpenAI** — direct GPT-4o access
- **Ollama** — local air-gapped deployment (no external calls)

**What breaks without it:** Agents receive tasks but cannot reason or produce
outputs. The pipeline stalls at the first agent stage.

---

## 10. Kubernetes / K3s

**Role:** Container orchestration, scaling, and self-healing.

K3s runs the entire stack as Kubernetes workloads and provides:

- **Deployments** — declarative replica management for runtime, MCP, agents
- **StatefulSets** — stable network identity for NATS and OpenSearch clusters
- **HPA** — scales the runtime from 3 → 10 pods when CPU exceeds 60%
- **Rolling updates** — `kubectl rollout` replaces pods one at a time with
  zero dropped alerts (maxUnavailable: 0)
- **Secrets / ConfigMaps** — credentials injected at runtime, never in images
- **Health probes** — restarts unhealthy pods automatically without manual
  intervention

**What breaks without it:** No self-healing, no auto-scaling. Manual container
management across nodes.

---

## 11. Tailscale

**Role:** Zero-trust encrypted mesh network across all nodes.

All nodes — Wazuh workers, runtime instances, monitoring — join the same
Tailscale tailnet. All inter-node traffic routes over Tailscale IPs.
No public ports are exposed; the cluster is unreachable from the internet
without Tailscale authentication.

Wazuh agents on monitored endpoints register with the manager's Tailscale IP
rather than a public IP, keeping agent traffic off the public internet.

**What breaks without it:** Nodes must expose ports publicly or manage their
own VPN — significantly increasing attack surface.

---

## 12. Prometheus + Grafana

**Role:** Observability — metrics collection and visualisation.

Prometheus scrapes `/metrics` endpoints from every component every 15 seconds.
Key metrics exposed:

| Metric | Source | Purpose |
|--------|--------|---------|
| `soc_alert_e2e_duration_seconds` | Runtime | Pipeline latency P50/P95/P99 |
| `soc_cases_open_total` | Runtime | Current investigation backlog |
| `soc_circuit_breaker_state` | Runtime | MCP tool health (0=CLOSED, 1=OPEN) |
| `soc_leader_election_total` | Runtime | Leader failover events |
| `nats_consumer_num_pending` | NATS | Queue depth per stream |
| `redis_command_duration_seconds` | Redis | State store latency |
| `agent_task_duration_seconds` | Agent wrappers | Per-agent processing time |

Grafana visualises all metrics on the SOC dashboard and triggers
Alertmanager notifications (Slack) when circuit breakers open, queue depth
spikes, or replicas fall below threshold.

**What breaks without it:** The system still functions but operators cannot
see whether it is healthy, detect degradation early, or prove benchmark
results.

---

## 13. Slack

**Role:** Human-in-the-loop approval gate.

After the Response Planner agent produces a remediation plan, the runtime posts
it to a designated Slack channel with Approve / Reject buttons. A designated
analyst reviews the proposed steps and approves or rejects before the Executor
agent acts. This gate prevents automated responses (isolate host, disable
account, block IP) from firing without human review.

The approval decision is written to Redis so any runtime replica can proceed,
not just the pod that posted the Slack message.

**What breaks without it:** The pipeline stalls at the approval stage
indefinitely. If Slack tokens are missing, a warning is logged and the
approval gate is skipped (configurable).

---

## Architecture summary

```
Endpoints → Wazuh cluster → OpenSearch
                 ↓
           Wazuh MCP Server (circuit-broken)
                 ↓
           NATS JetStream (ALERTS stream)
                 ↓
     ┌───── Autopilot Runtime (3 pods) ─────┐
     │  Leader election (Redis SET NX)       │
     │  Case state (Redis hashes)            │
     │  Pipeline dispatch (NATS pub/sub)     │
     └───────────────────────────────────────┘
                 ↓ AGENT_TASKS
     OpenClaw 7-agent pipeline (NATS wrappers)
                 ↓ AGENT_RESULTS
     Slack approval → Execution → Audit log
                 ↓
     Prometheus + Grafana (observability)
```
