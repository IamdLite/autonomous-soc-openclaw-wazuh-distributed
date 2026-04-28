#!/usr/bin/env bash
# =============================================================================
# verify.sh — Post-deployment verification
# Runs targeted health checks against every stack component and reports pass/fail
# Usage: ./verify.sh [--namespace soc-system]
# =============================================================================
set -euo pipefail

NS="${2:-soc-system}"
PASS=0; FAIL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'

pass() { echo -e "  ${GREEN}✔${RESET} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✘${RESET} $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
section() { echo -e "\n${YELLOW}▸ $1${RESET}"; }

# ── Wazuh cluster ─────────────────────────────────────────────────────────────
section "Wazuh cluster"

MASTER_READY=$(kubectl get deploy wazuh-master -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$MASTER_READY" -ge 1 ]] && pass "Wazuh master ready ($MASTER_READY/1)" || fail "Wazuh master not ready"

WORKER_READY=$(kubectl get deploy wazuh-worker -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$WORKER_READY" -ge 2 ]] && pass "Wazuh workers ready ($WORKER_READY/2)" || fail "Wazuh workers not ready (got $WORKER_READY)"

OS_READY=$(kubectl get statefulset opensearch -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$OS_READY" -ge 3 ]] && pass "OpenSearch ready ($OS_READY/3 nodes)" || fail "OpenSearch not fully ready ($OS_READY/3)"

# Cluster control check
CLUSTER_STATUS=$(kubectl exec -n "$NS" deploy/wazuh-master -- \
  /var/ossec/bin/cluster_control -l 2>/dev/null | grep -c "Connected" || echo 0)
[[ "$CLUSTER_STATUS" -ge 2 ]] && pass "Wazuh cluster: $CLUSTER_STATUS worker(s) connected" \
  || warn "Wazuh cluster_control returned $CLUSTER_STATUS connections (may need more time)"

# ── NATS JetStream ────────────────────────────────────────────────────────────
section "NATS JetStream"

NATS_READY=$(kubectl get statefulset nats -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$NATS_READY" -ge 3 ]] && pass "NATS cluster ready ($NATS_READY/3 nodes)" || fail "NATS not ready ($NATS_READY/3)"

for STREAM in ALERTS AGENT_TASKS AGENT_RESULTS APPROVALS; do
  EXISTS=$(kubectl exec -n "$NS" nats-0 -- \
    nats stream info "$STREAM" --server=nats://localhost:4222 2>/dev/null | grep -c "Stream Name" || echo 0)
  [[ "$EXISTS" -ge 1 ]] && pass "NATS stream $STREAM exists" || fail "NATS stream $STREAM missing"
done

# ── Redis Sentinel ────────────────────────────────────────────────────────────
section "Redis Sentinel"

REDIS_MASTER=$(kubectl get statefulset redis-master -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$REDIS_MASTER" -ge 1 ]] && pass "Redis master ready" || fail "Redis master not ready"

REDIS_REPLICAS=$(kubectl get statefulset redis-replicas -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$REDIS_REPLICAS" -ge 2 ]] && pass "Redis replicas ready ($REDIS_REPLICAS/2)" || fail "Redis replicas not ready ($REDIS_REPLICAS/2)"

SENTINEL_MASTER=$(kubectl exec -n "$NS" redis-master-0 -- \
  redis-cli -a "${REDIS_PASSWORD:-soc-redis-secret-change-me}" sentinel masters 2>/dev/null | grep -c "soc-master" || echo 0)
[[ "$SENTINEL_MASTER" -ge 1 ]] && pass "Redis Sentinel tracking master" || fail "Redis Sentinel not tracking master"

# ── Autopilot Runtime ─────────────────────────────────────────────────────────
section "Autopilot Runtime"

RUNTIME_READY=$(kubectl get deploy autopilot-runtime -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$RUNTIME_READY" -ge 3 ]] && pass "Runtime replicas ready ($RUNTIME_READY/3)" || fail "Runtime replicas not ready ($RUNTIME_READY/3)"

# Health endpoint check on first pod
RUNTIME_POD=$(kubectl get pod -n "$NS" -l app=autopilot-runtime -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$RUNTIME_POD" ]]; then
  HEALTH=$(kubectl exec -n "$NS" "$RUNTIME_POD" -- wget -qO- http://localhost:8080/healthz 2>/dev/null || echo "{}")
  STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")
  [[ "$STATUS" == "ok" ]] && pass "Runtime /healthz: $STATUS" || fail "Runtime /healthz: $STATUS"

  LEADER=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('leader', False))" 2>/dev/null || echo "False")
  [[ "$LEADER" == "True" ]] && pass "Leader pod identified: $RUNTIME_POD" || warn "This pod is not the leader (expected for non-leader pods)"
fi

# HPA
HPA_EXISTS=$(kubectl get hpa autopilot-runtime-hpa -n "$NS" 2>/dev/null | grep -c "autopilot" || echo 0)
[[ "$HPA_EXISTS" -ge 1 ]] && pass "HPA configured" || fail "HPA not found"

# ── Wazuh MCP Server ──────────────────────────────────────────────────────────
section "Wazuh MCP Server"

MCP_READY=$(kubectl get deploy wazuh-mcp -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$MCP_READY" -ge 2 ]] && pass "MCP server ready ($MCP_READY/2)" || fail "MCP server not ready ($MCP_READY/2)"

MCP_POD=$(kubectl get pod -n "$NS" -l app=wazuh-mcp -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$MCP_POD" ]]; then
  MCP_HEALTH=$(kubectl exec -n "$NS" "$MCP_POD" -- wget -qO- http://localhost:3000/health 2>/dev/null | grep -c "ok" || echo 0)
  [[ "$MCP_HEALTH" -ge 1 ]] && pass "MCP /health: ok" || fail "MCP /health check failed"
fi

# ── OpenClaw Agents ────────────────────────────────────────────────────────────
section "OpenClaw Agents (7 pipeline stages)"

for AGENT in triage correlation investigation response-planner slack-notifier executor audit-logger; do
  READY=$(kubectl get deploy "agent-${AGENT}" -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
  [[ "$READY" -ge 1 ]] && pass "agent-${AGENT}: ready" || fail "agent-${AGENT}: not ready"
done

# ── Observability ─────────────────────────────────────────────────────────────
section "Observability (Prometheus + Grafana)"

PROM_READY=$(kubectl get deploy kube-prometheus-kube-prome-prometheus -n monitoring -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$PROM_READY" -ge 1 ]] && pass "Prometheus ready" || warn "Prometheus not ready (check monitoring namespace)"

GRAFANA_READY=$(kubectl get deploy kube-prometheus-grafana -n monitoring -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
[[ "$GRAFANA_READY" -ge 1 ]] && pass "Grafana ready" || warn "Grafana not ready"

SM_COUNT=$(kubectl get servicemonitors -n "$NS" 2>/dev/null | grep -c "soc" || echo 0)
[[ "$SM_COUNT" -ge 3 ]] && pass "ServiceMonitors: $SM_COUNT configured" || warn "Expected ≥3 ServiceMonitors, found $SM_COUNT"

# ── End-to-end smoke test ─────────────────────────────────────────────────────
section "End-to-end smoke test (synthetic alert)"

if [[ -n "${RUNTIME_POD:-}" ]]; then
  echo "  Injecting 1 synthetic alert..."
  kubectl exec -n "$NS" "$RUNTIME_POD" -- \
    node /app/src/scripts/inject-alerts.js --count 1 --level 10 2>/dev/null \
    && pass "Synthetic alert injected successfully" \
    || warn "Alert injection failed (pipeline may still be starting)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo -e "  Results: ${GREEN}${PASS} passed${RESET}  ${RED}${FAIL} failed${RESET}"
echo "════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "Troubleshooting:"
  echo "  kubectl get events -n $NS --sort-by='.lastTimestamp' | tail -20"
  echo "  kubectl describe pod -n $NS -l app=autopilot-runtime"
  exit 1
fi

echo ""
echo "All checks passed. Access your stack:"
echo "  Grafana:    kubectl port-forward svc/kube-prometheus-grafana 3000:80 -n monitoring"
echo "  Prometheus: kubectl port-forward svc/kube-prometheus-kube-prome-prometheus 9090:9090 -n monitoring"
echo "  Runtime:    kubectl port-forward svc/autopilot-runtime 8080:8080 -n $NS"
