#!/usr/bin/env bash
# Create N kind clusters (one per parallel worker), preload the images, and
# write three kubeconfigs per cluster into run/:
#   kc-admin-i      cluster-admin, used by the harness to break, check and reset
#   kc-agent-i      the oncall-agent service account (guarded arm)
#   kc-unguarded-i  cluster-admin with namespace shop as default (unguarded arm)
# Needs docker, kind and kubectl on PATH. Usage: scripts/00-setup-clusters.sh 6
set -euo pipefail
N=${1:-1}
cd "$(dirname "$0")/.."
mkdir -p run
IMAGES="docker.io/library/busybox:1.36 docker.io/library/nginx:1.27-alpine docker.io/library/redis:7-alpine"
for i in $(seq 1 "$N"); do
  name="agentops-$i"
  kind get clusters | grep -qx "$name" || kind create cluster --name "$name" --wait 120s
  kind get kubeconfig --name "$name" > "run/kc-admin-$i"
  # Pull inside the node once, so incidents never wait on Docker Hub.
  # (kind load fails with Docker's containerd image store.)
  for img in $IMAGES; do docker exec "$name-control-plane" crictl pull "$img" >/dev/null; done
  kubectl --kubeconfig "run/kc-admin-$i" apply -f cluster/agent-sa.yaml >/dev/null
  cp "run/kc-admin-$i" "run/kc-unguarded-$i"
  kubectl --kubeconfig "run/kc-unguarded-$i" config set-context --current --namespace=shop >/dev/null
  token=$(kubectl --kubeconfig "run/kc-admin-$i" -n agent-system create token oncall-agent --duration=72h)
  server=$(kubectl --kubeconfig "run/kc-admin-$i" config view --minify -o jsonpath='{.clusters[0].cluster.server}')
  kubectl --kubeconfig "run/kc-admin-$i" config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > "run/ca-$i.crt"
  KC="run/kc-agent-$i"
  rm -f "$KC"
  kubectl --kubeconfig "$KC" config set-cluster "$name" --server="$server" --certificate-authority="run/ca-$i.crt" --embed-certs=true >/dev/null
  kubectl --kubeconfig "$KC" config set-credentials oncall-agent --token="$token" >/dev/null
  kubectl --kubeconfig "$KC" config set-context agent --cluster="$name" --user=oncall-agent --namespace=shop >/dev/null
  kubectl --kubeconfig "$KC" config use-context agent >/dev/null
  chmod 600 run/kc-*
  echo "cluster $i ready"
done
