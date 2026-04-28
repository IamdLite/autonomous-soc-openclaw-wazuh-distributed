#!/usr/bin/env bash
# =============================================================================
# Wazuh-OpenClaw-Autopilot  —  Distributed Kubernetes Deployment Playbook
# =============================================================================
# Usage:
#   ./deploy.sh install        Full stack deployment (first run)
#   ./deploy.sh upgrade        Rolling upgrade of runtime pods
#   ./deploy.sh status         Show health of every component
#   ./deploy.sh teardown       Destroy everything (keeps PVCs by default)
#   ./deploy.sh teardown --purge   Destroy including persistent volumes
#   ./deploy.sh logs <svc>     Tail logs for a service
#   ./deploy.sh bench          Run synthetic alert burst (200 alerts)
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

# ── colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()    { echo -e "${GREEN}[ OK ]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()   { echo -e "${RED}[FAIL]${RESET}  $*" >&2; exit 1; }
banner(){ echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}\n"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
K8S_DIR="${SCRIPT_DIR}/k8s"
NAMESPACE="soc-system"
RUNTIME_IMAGE="ghcr.io/gensecaihq/autopilot-runtime:latest"

# ── load .env ─────────────────────────────────────────────────────────────────
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    warn ".env not found — copying from .env.example"
    cp "${SCRIPT_DIR}/.env.example" "$ENV_FILE"
    die "Edit $ENV_FILE with your credentials, then re-run."
  fi
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
}

# ── pre-flight checks ──────────────────────────────────────────────────────────
preflight() {
  banner "Pre-flight checks"
  local missing=()
  for cmd in kubectl helm docker git curl jq; do
    if command -v "$cmd" &>/dev/null; then ok "$cmd found"; else missing+=("$cmd"); fi
  done
  [[ ${#missing[@]} -gt 0 ]] && die "Missing tools: ${missing[*]}"

  # k8s connectivity
  kubectl cluster-info &>/dev/null || die "Cannot reach Kubernetes cluster. Is kubeconfig set?"
  ok "Kubernetes cluster reachable"

  # required env vars
  local required_vars=(WAZUH_HOST WAZUH_USER WAZUH_PASS LLM_API_KEY SLACK_APP_TOKEN SLACK_BOT_TOKEN)
  for v in "${required_vars[@]}"; do
    [[ -n "${!v:-}" ]] || die "Missing required env var: $v"
    ok "$v set"
  done
}

# ── namespace & secrets ────────────────────────────────────────────────────────
setup_namespace() {
  banner "Namespace & Secrets"
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  ok "Namespace $NAMESPACE ready"

  # Wazuh credentials
  kubectl create secret generic wazuh-credentials \
    --from-literal=host="${WAZUH_HOST}" \
    --from-literal=port="${WAZUH_PORT:-55000}" \
    --from-literal=user="${WAZUH_USER}" \
    --from-literal=password="${WAZUH_PASS}" \
    --namespace "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -

  # LLM + Slack
  kubectl create secret generic autopilot-secrets \
    --from-literal=llm-api-key="${LLM_API_KEY}" \
    --from-literal=llm-base-url="${LLM_BASE_URL:-https://openrouter.ai/api/v1}" \
    --from-literal=llm-model="${LLM_MODEL:-anthropic/claude-3.5-sonnet}" \
    --from-literal=slack-app-token="${SLACK_APP_TOKEN}" \
    --from-literal=slack-bot-token="${SLACK_BOT_TOKEN}" \
    --from-literal=mcp-auth-token="${MCP_AUTH_TOKEN:-$(openssl rand -hex 32)}" \
    --namespace "$NAMESPACE" \
    --dry-run=client -o yaml | kubectl apply -f -

  ok "Secrets applied"
}

# ── Helm repos ─────────────────────────────────────────────────────────────────
add_helm_repos() {
  banner "Helm repositories"
  helm repo add nats        https://nats-io.github.io/k8s/helm/charts/ 2>/dev/null || true
  helm repo add bitnami     https://charts.bitnami.com/bitnami          2>/dev/null || true
  helm repo add prometheus  https://prometheus-community.github.io/helm-charts 2>/dev/null || true
  helm repo add grafana     https://grafana.github.io/helm-charts       2>/dev/null || true
  helm repo update
  ok "Helm repos updated"
}

# ── NATS JetStream cluster ─────────────────────────────────────────────────────
deploy_nats() {
  banner "NATS JetStream (3-node cluster)"
  helm upgrade --install nats nats/nats \
    --namespace "$NAMESPACE" \
    --values "${K8S_DIR}/nats/values.yaml" \
    --wait --timeout 5m
  ok "NATS cluster deployed"

  # Wait for all 3 pods
  kubectl rollout status statefulset/nats -n "$NAMESPACE" --timeout=120s
  ok "NATS StatefulSet ready"

  # Create streams via job
  kubectl apply -f "${K8S_DIR}/nats/stream-init-job.yaml" -n "$NAMESPACE"
  kubectl wait --for=condition=complete job/nats-stream-init -n "$NAMESPACE" --timeout=60s
  ok "NATS streams (ALERTS, AGENT_TASKS, AGENT_RESULTS, APPROVALS) created"
}

# ── Redis Sentinel ─────────────────────────────────────────────────────────────
deploy_redis() {
  banner "Redis Sentinel (1 primary + 2 replicas)"
  helm upgrade --install redis bitnami/redis \
    --namespace "$NAMESPACE" \
    --values "${K8S_DIR}/redis/values.yaml" \
    --wait --timeout 5m
  ok "Redis Sentinel deployed"
  kubectl rollout status statefulset/redis-master -n "$NAMESPACE" --timeout=120s
  ok "Redis master ready"
}

# ── Wazuh cluster ──────────────────────────────────────────────────────────────
deploy_wazuh() {
  banner "Wazuh cluster (master + 2 workers + OpenSearch)"
  kubectl apply -f "${K8S_DIR}/wazuh/" -n "$NAMESPACE" --recursive
  info "Waiting for Wazuh master..."
  kubectl rollout status deployment/wazuh-master -n "$NAMESPACE" --timeout=300s
  info "Waiting for Wazuh workers..."
  kubectl rollout status deployment/wazuh-worker -n "$NAMESPACE" --timeout=300s
  info "Waiting for OpenSearch..."
  kubectl rollout status statefulset/opensearch -n "$NAMESPACE" --timeout=300s
  ok "Wazuh cluster ready"
}

# ── Wazuh MCP Server ───────────────────────────────────────────────────────────
deploy_mcp() {
  banner "Wazuh MCP Server (2 replicas)"
  kubectl apply -f "${K8S_DIR}/mcp/" -n "$NAMESPACE"
  kubectl rollout status deployment/wazuh-mcp -n "$NAMESPACE" --timeout=120s
  ok "Wazuh MCP Server ready"
}

# ── Autopilot Runtime ──────────────────────────────────────────────────────────
deploy_runtime() {
  banner "Autopilot Runtime (3 replicas + HPA)"
  kubectl apply -f "${K8S_DIR}/runtime/" -n "$NAMESPACE"
  kubectl rollout status deployment/autopilot-runtime -n "$NAMESPACE" --timeout=180s
  ok "Autopilot runtime ready (3 replicas)"

  # Apply HPA
  kubectl apply -f "${K8S_DIR}/runtime/hpa.yaml" -n "$NAMESPACE"
  ok "HPA configured (target 60% CPU, max 10 replicas)"
}

# ── Observability ──────────────────────────────────────────────────────────────
deploy_observability() {
  banner "Prometheus + Grafana"
  helm upgrade --install kube-prometheus prometheus/kube-prometheus-stack \
    --namespace monitoring \
    --create-namespace \
    --values "${K8S_DIR}/observability/prometheus-values.yaml" \
    --wait --timeout 10m
  ok "Prometheus stack deployed"

  # Custom SOC dashboard
  kubectl apply -f "${K8S_DIR}/observability/grafana-dashboard-configmap.yaml" -n monitoring
  ok "SOC Grafana dashboard loaded"

  # ServiceMonitors for NATS, Redis, Runtime
  kubectl apply -f "${K8S_DIR}/observability/service-monitors.yaml" -n "$NAMESPACE"
  ok "ServiceMonitors applied"
}

# ── NGINX Ingress ──────────────────────────────────────────────────────────────
deploy_ingress() {
  banner "NGINX Ingress (load balancer)"
  kubectl apply -f "${K8S_DIR}/ingress/" -n "$NAMESPACE"
  ok "Ingress rules applied"
}

# ── status ─────────────────────────────────────────────────────────────────────
show_status() {
  banner "System Status"
  echo ""
  echo -e "${BOLD}Pods:${RESET}"
  kubectl get pods -n "$NAMESPACE" -o wide
  echo ""
  echo -e "${BOLD}Services:${RESET}"
  kubectl get svc -n "$NAMESPACE"
  echo ""
  echo -e "${BOLD}HPA:${RESET}"
  kubectl get hpa -n "$NAMESPACE" 2>/dev/null || true
  echo ""
  echo -e "${BOLD}NATS Streams:${RESET}"
  kubectl exec -n "$NAMESPACE" nats-0 -- nats stream list 2>/dev/null || warn "NATS CLI not available in pod"
  echo ""
  echo -e "${BOLD}Redis Sentinel:${RESET}"
  kubectl exec -n "$NAMESPACE" redis-master-0 -- redis-cli -a "${REDIS_PASSWORD:-soc-redis-secret}" sentinel masters 2>/dev/null | head -20 || true
  echo ""
  echo -e "${BOLD}Grafana:${RESET} kubectl port-forward svc/kube-prometheus-grafana 3000:80 -n monitoring"
  echo -e "${BOLD}Prometheus:${RESET} kubectl port-forward svc/kube-prometheus-kube-prome-prometheus 9090:9090 -n monitoring"
}

# ── rolling upgrade ────────────────────────────────────────────────────────────
upgrade_runtime() {
  banner "Rolling upgrade — Autopilot Runtime"
  info "Pulling latest image..."
  kubectl set image deployment/autopilot-runtime \
    autopilot="${RUNTIME_IMAGE}" \
    -n "$NAMESPACE"
  kubectl rollout status deployment/autopilot-runtime -n "$NAMESPACE" --timeout=300s
  ok "Rolling upgrade complete — zero downtime"
}

# ── teardown ───────────────────────────────────────────────────────────────────
teardown() {
  banner "Teardown"
  warn "This will delete all SOC components from namespace $NAMESPACE"
  read -r -p "Are you sure? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }

  helm uninstall nats  -n "$NAMESPACE" 2>/dev/null || true
  helm uninstall redis -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete -f "${K8S_DIR}/" -n "$NAMESPACE" --recursive --ignore-not-found 2>/dev/null || true

  if [[ "${1:-}" == "--purge" ]]; then
    warn "Purging persistent volume claims..."
    kubectl delete pvc --all -n "$NAMESPACE" 2>/dev/null || true
    kubectl delete namespace "$NAMESPACE" 2>/dev/null || true
    helm uninstall kube-prometheus -n monitoring 2>/dev/null || true
    kubectl delete namespace monitoring 2>/dev/null || true
  fi
  ok "Teardown complete"
}

# ── synthetic benchmark ────────────────────────────────────────────────────────
run_bench() {
  banner "Synthetic alert burst (200 alerts)"
  local runtime_pod
  runtime_pod=$(kubectl get pod -n "$NAMESPACE" -l app=autopilot-runtime \
    -o jsonpath='{.items[0].metadata.name}')
  info "Injecting 200 synthetic alerts via $runtime_pod"
  kubectl exec -n "$NAMESPACE" "$runtime_pod" -- \
    node /app/scripts/inject-alerts.js --count 200 --rate 50 2>&1 | tail -5
  info "Watch HPA scaling: kubectl get hpa -n $NAMESPACE --watch"
}

# ── log tail ───────────────────────────────────────────────────────────────────
tail_logs() {
  local svc="${1:-autopilot-runtime}"
  kubectl logs -n "$NAMESPACE" -l "app=$svc" --all-containers --follow --tail=50
}

# ── main ───────────────────────────────────────────────────────────────────────
main() {
  local cmd="${1:-help}"
  case "$cmd" in
    install)
      load_env
      preflight
      setup_namespace
      add_helm_repos
      deploy_nats
      deploy_redis
      deploy_wazuh
      deploy_mcp
      deploy_runtime
      deploy_observability
      deploy_ingress
      echo ""
      ok "═══════════════════════════════════════════"
      ok " Distributed SOC stack fully deployed!"
      ok "═══════════════════════════════════════════"
      show_status
      ;;
    upgrade)   load_env; upgrade_runtime ;;
    status)    show_status ;;
    teardown)  teardown "${2:-}" ;;
    bench)     run_bench ;;
    logs)      tail_logs "${2:-}" ;;
    *)
      echo "Usage: $0 {install|upgrade|status|teardown [--purge]|bench|logs <svc>}"
      ;;
  esac
}

main "$@"
