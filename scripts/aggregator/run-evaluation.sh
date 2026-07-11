#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="aggregator-platform"
RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR=""
USER_NAME=""
PASSWORD="pass"
AGGREGATOR_ID=""
PATIENTS=""
SERVICES="wearable-gsr,wearable-bvp,wearable-skt,wearable-ibi"
POLL_INTERVAL="60s"
DURATION="20m"
MEASUREMENT_LOG_INTERVAL_MS="0"
STREAM_IDLE_TIMEOUT_MS=""
STREAM_FIRST_DATA_TIMEOUT_MS=""
STATIC_CATCHUP_INTERVAL_MS=""
CLEANUP_AFTER="false"
UPLOAD_CMD=""

usage() {
  cat <<'EOF'
Usage:
  ./aggregator/run-evaluation.sh \
    --run-id low-w1-001 \
    --user eval-low4 \
    --aggregator-id c0e83a1e-ff27-43bd-bf56-653497cf8aef \
    --patients eval-low4,eval-low5 \
    --services wearable-gsr,wearable-bvp \
    --duration 20m \
    --poll-interval 60s

Optional:
  --run-dir DIR
  --password pass
  --namespace aggregator-platform
  --measurement-log-interval-ms 0
  --stream-idle-timeout-ms 0
  --stream-first-data-timeout-ms 0
  --static-catchup-interval-ms 0
  --upload-cmd "bash /path/to/uploader.sh"
  --cleanup-after

The script:
  1. Deletes existing generated aggregator service deployments/services.
  2. Sets RUN_ID/logging env vars on aggregator-server and waits for rollout.
  3. Creates fresh generated metric services.
  4. Waits for generated service rollout.
  5. Captures one log file per generated service.
  6. Runs poll-service into poll-results.jsonl.
  7. Writes metadata.json.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --aggregator-id) AGGREGATOR_ID="$2"; shift 2 ;;
    --patients) PATIENTS="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --measurement-log-interval-ms) MEASUREMENT_LOG_INTERVAL_MS="$2"; shift 2 ;;
    --stream-idle-timeout-ms) STREAM_IDLE_TIMEOUT_MS="$2"; shift 2 ;;
    --stream-first-data-timeout-ms) STREAM_FIRST_DATA_TIMEOUT_MS="$2"; shift 2 ;;
    --static-catchup-interval-ms) STATIC_CATCHUP_INTERVAL_MS="$2"; shift 2 ;;
    --upload-cmd) UPLOAD_CMD="$2"; shift 2 ;;
    --cleanup-after) CLEANUP_AFTER="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$USER_NAME" ]]; then
  echo "Missing --user" >&2
  exit 1
fi

if [[ -z "$AGGREGATOR_ID" ]]; then
  echo "Missing --aggregator-id" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"

if [[ -z "$RUN_DIR" ]]; then
  RUN_DIR="$REPO_DIR/runs/$RUN_ID"
fi

LOG_DIR="$RUN_DIR/logs"
mkdir -p "$LOG_DIR"

LOG_PIDS=()
UPLOAD_PID=""

stop_background_jobs() {
  for pid in "${LOG_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  if [[ -n "$UPLOAD_PID" ]] && kill -0 "$UPLOAD_PID" 2>/dev/null; then
    kill "$UPLOAD_PID" 2>/dev/null || true
  fi
}

cleanup_generated_services() {
  kubectl -n "$NAMESPACE" delete deployment,service \
    -l "app.kubernetes.io/name=aggregator-service,agg.knows.idlab.ugent.be/managed-by=$AGGREGATOR_ID" \
    --ignore-not-found --wait=true
}

trap stop_background_jobs EXIT

echo "[$(date -u +%FT%TZ)] Run directory: $RUN_DIR"
echo "[$(date -u +%FT%TZ)] Cleaning generated services for aggregator $AGGREGATOR_ID"
cleanup_generated_services

echo "[$(date -u +%FT%TZ)] Setting aggregator-server evaluation env"
ENV_ARGS=("RUN_ID=$RUN_ID" "EVALUATION_RUN_ID=$RUN_ID" "MEASUREMENT_LOG_INTERVAL_MS=$MEASUREMENT_LOG_INTERVAL_MS")
if [[ -n "$STREAM_IDLE_TIMEOUT_MS" ]]; then ENV_ARGS+=("STREAM_IDLE_TIMEOUT_MS=$STREAM_IDLE_TIMEOUT_MS"); fi
if [[ -n "$STREAM_FIRST_DATA_TIMEOUT_MS" ]]; then ENV_ARGS+=("STREAM_FIRST_DATA_TIMEOUT_MS=$STREAM_FIRST_DATA_TIMEOUT_MS"); fi
if [[ -n "$STATIC_CATCHUP_INTERVAL_MS" ]]; then ENV_ARGS+=("STATIC_CATCHUP_INTERVAL_MS=$STATIC_CATCHUP_INTERVAL_MS"); fi
kubectl -n "$NAMESPACE" set env deployment/aggregator-server "${ENV_ARGS[@]}"
kubectl -n "$NAMESPACE" rollout status deployment/aggregator-server --timeout=180s

cat > "$RUN_DIR/metadata.json" <<EOF
{
  "run_id": "$RUN_ID",
  "namespace": "$NAMESPACE",
  "aggregator_id": "$AGGREGATOR_ID",
  "user": "$USER_NAME",
  "patients": "$PATIENTS",
  "services": "$SERVICES",
  "duration": "$DURATION",
  "poll_interval": "$POLL_INTERVAL",
  "measurement_log_interval_ms": "$MEASUREMENT_LOG_INTERVAL_MS",
  "stream_idle_timeout_ms": "$STREAM_IDLE_TIMEOUT_MS",
  "stream_first_data_timeout_ms": "$STREAM_FIRST_DATA_TIMEOUT_MS",
  "static_catchup_interval_ms": "$STATIC_CATCHUP_INTERVAL_MS",
  "started_at": "$(date -u +%FT%TZ)"
}
EOF

echo "[$(date -u +%FT%TZ)] Creating services: $SERVICES"
(
  cd "$SCRIPTS_DIR"
  RUN_ID="$RUN_ID" \
  EVALUATION_RUN_ID="$RUN_ID" \
  SERVICE_REQUESTOR="$USER_NAME" \
  SERVICE_REQUESTOR_PASSWORD="$PASSWORD" \
  KVASIR_PATIENTS="$PATIENTS" \
  AGGREGATOR_SERVICES="$SERVICES" \
  npm run create-services-patient-metrics
) | tee "$RUN_DIR/create-services.log"

echo "[$(date -u +%FT%TZ)] Waiting for generated deployments"
mapfile -t DEPLOYMENTS < <(
  kubectl -n "$NAMESPACE" get deployments \
    -l "app.kubernetes.io/name=aggregator-service,agg.knows.idlab.ugent.be/managed-by=$AGGREGATOR_ID" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
)

if [[ "${#DEPLOYMENTS[@]}" -eq 0 ]]; then
  echo "No generated deployments found after service creation" >&2
  exit 1
fi

for deployment in "${DEPLOYMENTS[@]}"; do
  kubectl -n "$NAMESPACE" rollout status "deployment/$deployment" --timeout=180s
done

echo "[$(date -u +%FT%TZ)] Starting log capture"
for deployment in "${DEPLOYMENTS[@]}"; do
  kubectl -n "$NAMESPACE" logs -f "deployment/$deployment" --all-containers --prefix > "$LOG_DIR/$deployment.log" 2>&1 &
  LOG_PIDS+=("$!")
done

if [[ -n "$UPLOAD_CMD" ]]; then
  echo "[$(date -u +%FT%TZ)] Starting uploader command"
  bash -lc "$UPLOAD_CMD" > "$RUN_DIR/uploader.log" 2>&1 &
  UPLOAD_PID="$!"
fi

echo "[$(date -u +%FT%TZ)] Starting poller"
(
  cd "$SCRIPTS_DIR"
  npm run poll-service -- \
    --user "$USER_NAME" \
    --password "$PASSWORD" \
    --aggregator-id "$AGGREGATOR_ID" \
    --svc "$SERVICES" \
    --interval "$POLL_INTERVAL" \
    --duration "$DURATION" \
    --run-id "$RUN_ID" \
    --out "$RUN_DIR/poll-results.jsonl"
) | tee "$RUN_DIR/poll-service.log"

echo "[$(date -u +%FT%TZ)] Poller finished"
stop_background_jobs

if [[ "$CLEANUP_AFTER" == "true" ]]; then
  echo "[$(date -u +%FT%TZ)] Cleaning generated services after run"
  cleanup_generated_services
fi

echo "[$(date -u +%FT%TZ)] Run complete: $RUN_DIR"
