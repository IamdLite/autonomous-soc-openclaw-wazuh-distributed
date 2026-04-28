# Wazuh-OpenClaw-Autopilot — Distributed Kubernetes Edition

A production-grade distributed extension of the
[Wazuh-OpenClaw-Autopilot](https://github.com/gensecaihq/Wazuh-Openclaw-Autopilot)
autonomous SOC system. The base project is a single-node, single-process
pipeline. This repository adds the full distributed layer:

| Added layer | Technology | Replaces |
|-------------|-----------|---------|
| Durable message queue | NATS JetStream (3-node) | `localhost:9090` webhooks |
| Shared case state | Redis Sentinel (1+2) | In-memory `Map` objects |
| Leader election | Redis `SET NX PX` | Single-process assumption |
| Fault isolation | opossum circuit breakers | Unchecked MCP calls |
| Container orchestration | K3s + HPA | Single Docker process |
| Zero-trust networking | Tailscale mesh | Exposed public ports |
| Full observability | Prometheus + Grafana | No metrics |

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/YOUR_ORG/soc-distributed.git
cd soc-distributed

# 2. Configure credentials
cp .env.example .env
$EDITOR .env          # fill in Wazuh, LLM, Slack credentials

# 3. Deploy everything
chmod +x deploy.sh scripts/*.sh
./deploy.sh install

# 4. Verify all components
./scripts/verify.sh

# 5. Run benchmarks (optional)
./scripts/bench.sh all
```

The `deploy.sh install` command handles, in order:
pre-flight checks → namespace + secrets → Helm repos → NATS → Redis →
Wazuh cluster → MCP server → runtime (3 replicas) → HPA → Prometheus/Grafana → ingress.

---

## Repository structure

```
soc-distributed/
├── deploy.sh                    # Main deployment playbook
├── .env.example                 # All required environment variables
├── package.json                 # Node.js dependencies
│
├── src/
│   ├── runtime/
│   │   └── index.js             # Patched Autopilot runtime (NATS + Redis + CBs)
│   ├── agents/
│   │   └── nats-wrapper.js      # OpenClaw agent NATS adapter
│   └── scripts/
│       ├── inject-alerts.js     # Synthetic alert injector (benchmarks)
│       └── release-leader-lock.js # preStop hook — releases Redis leader lock
│
├── docker/
│   ├── Dockerfile               # Autopilot runtime image
│   └── Dockerfile.agent         # Agent NATS wrapper image
│
├── k8s/
│   ├── wazuh/
│   │   ├── 01-wazuh-master.yaml  # Master node deployment + config
│   │   ├── 02-wazuh-worker.yaml  # Worker deployment (2 replicas)
│   │   └── 03-opensearch.yaml    # 3-node OpenSearch StatefulSet
│   ├── nats/
│   │   ├── values.yaml           # NATS JetStream Helm values
│   │   └── stream-init-job.yaml  # Creates all 4 streams on first deploy
│   ├── redis/
│   │   └── values.yaml           # Redis Sentinel Helm values
│   ├── mcp/
│   │   └── wazuh-mcp.yaml        # Wazuh MCP Server (2 replicas)
│   ├── runtime/
│   │   ├── configmap.yaml        # All non-secret runtime config
│   │   ├── deployment.yaml       # 3-replica runtime deployment
│   │   ├── hpa.yaml              # HPA: 3→10 replicas at 60% CPU
│   │   └── agents.yaml           # All 7 OpenClaw agent deployments
│   ├── tailscale/
│   │   └── daemonset.yaml        # Tailscale node mesh DaemonSet
│   ├── ingress/
│   │   └── ingress.yaml          # NGINX ingress rules
│   └── observability/
│       ├── prometheus-values.yaml        # kube-prometheus-stack values
│       ├── service-monitors.yaml         # Prometheus scrape targets
│       ├── grafana-dashboard-configmap.yaml # SOC Grafana dashboard
│       └── alert-rules.yaml              # PrometheusRules (alerting)
│
├── scripts/
│   ├── verify.sh                # Post-deploy health check suite
│   └── bench.sh                 # 4-scenario benchmark runner
│
└── docs/
    └── components.md            # Full component reference
```

---

## Deployment commands

| Command | Description |
|---------|-------------|
| `./deploy.sh install` | Full first-time deployment |
| `./deploy.sh status` | Health overview of all components |
| `./deploy.sh upgrade` | Rolling update of runtime pods (zero downtime) |
| `./deploy.sh bench` | Inject 200 synthetic alerts (HPA demo) |
| `./deploy.sh logs autopilot-runtime` | Tail runtime logs |
| `./deploy.sh teardown` | Remove stack (keeps PVCs) |
| `./deploy.sh teardown --purge` | Remove stack including all data |
| `./scripts/verify.sh` | Component-by-component health checks |
| `./scripts/bench.sh all` | Run all 4 benchmark scenarios |
| `./scripts/bench.sh 2` | Run only scenario 2 (node failure) |

---

## Accessing services

```bash
# Grafana dashboard (admin / soc-grafana-admin)
kubectl port-forward svc/kube-prometheus-grafana 3000:80 -n monitoring

# Prometheus
kubectl port-forward svc/kube-prometheus-kube-prome-prometheus 9090:9090 -n monitoring

# Runtime health
kubectl port-forward svc/autopilot-runtime 8080:8080 -n soc-system
curl http://localhost:8080/healthz

# Runtime Prometheus metrics
curl http://localhost:8080/../9090/metrics   # (via port-forward on 9090)

# NATS stream status
kubectl exec -n soc-system nats-0 -- nats stream list

# Redis leader check
kubectl exec -n soc-system redis-master-0 -- \
  redis-cli -a YOUR_REDIS_PASSWORD get soc:leader:poll-lock

# Watch HPA during burst
kubectl get hpa autopilot-runtime-hpa -n soc-system --watch
```

---

## Distributed systems concepts mapped

| Implementation | Concept |
|----------------|---------|
| NATS JetStream streams | Reliable message delivery, at-least-once semantics |
| Redis `SET NX PX` leader election | Distributed coordination, single-writer guarantee |
| Redis Sentinel failover | High availability, automatic primary promotion |
| opossum circuit breakers | Fault isolation, fail-fast pattern |
| HPA (3→10 replicas) | Horizontal scalability, elastic compute |
| Wazuh master+2 workers | Data replication, detection availability |
| Rolling update (maxUnavailable: 0) | Zero-downtime deployment |
| Tailscale mesh | Zero-trust networking, encrypted overlay |

---

## Prerequisites

- Kubernetes cluster (K3s recommended: `curl -sfL https://get.k3s.io | sh -`)
- `kubectl`, `helm`, `docker`, `curl`, `jq`
- Wazuh manager accessible on the network (or deploy via this playbook)
- LLM API key (OpenRouter, OpenAI, or local Ollama)
- Slack app with Socket Mode enabled (for approval gate)

See `docs/components.md` for a full description of every component.
