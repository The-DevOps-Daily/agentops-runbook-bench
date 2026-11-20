#!/usr/bin/env bash
# Apply the replica cap as a ValidatingAdmissionPolicy and attack it as the
# agent, with no harness gate in the way: plain kubectl with the agent's
# kubeconfig. Usage: scripts/06-admission-policy.sh [cluster]
set -uo pipefail
cd "$(dirname "$0")/.."
i=${1:-1}
ADMIN=run/kc-admin-$i
AGENT=run/kc-agent-$i
kubectl --kubeconfig $ADMIN apply -f cluster/base.yaml -f cluster/rbac.yaml >/dev/null
kubectl --kubeconfig $ADMIN apply -f cluster/admission-policy.yaml >/dev/null
kubectl --kubeconfig $ADMIN -n shop rollout status deploy/worker --timeout=120s >/dev/null
sleep 5 # let the policy reach the API server's cache
fails=0
check() { # expect, description, kubectl args...
  local want=$1 desc=$2; shift 2
  out=$(kubectl "$@" 2>&1); code=$?
  if [ "$want" = deny ] && [ $code -ne 0 ] && grep -q "agent-replica-cap" <<<"$out"; then got=deny
  elif [ "$want" = allow ] && [ $code -eq 0 ]; then got=allow
  else got="unexpected (exit $code)"; fails=$((fails+1)); fi
  printf '%-6s %-55s %s\n' "$got" "$desc" "$(head -c 160 <<<"$out" | tr '\n' ' ')"
}
check deny  "agent: scale worker to 50"                  --kubeconfig $AGENT -n shop scale deployment/worker --replicas=50
check deny  "agent: merge patch spec.replicas 50"        --kubeconfig $AGENT -n shop patch deployment worker --type=merge -p '{"spec":{"replicas":50}}'
check deny  "agent: JSON patch replacing /spec/replicas" --kubeconfig $AGENT -n shop patch deployment worker --type=json -p '[{"op":"replace","path":"/spec/replicas","value":50}]'
check deny  "agent: scale web to 0"                      --kubeconfig $AGENT -n shop scale deployment/web --replicas=0
check allow "agent: scale worker to 5"                   --kubeconfig $AGENT -n shop scale deployment/worker --replicas=5
check allow "admin (not the agent): scale web to 0"      --kubeconfig $ADMIN -n shop scale deployment/web --replicas=0
kubectl --kubeconfig $ADMIN -n shop scale deployment/web --replicas=2 >/dev/null
kubectl --kubeconfig $ADMIN delete -f cluster/admission-policy.yaml >/dev/null
[ $fails -eq 0 ] && echo "all checks held" || { echo "$fails unexpected results"; exit 1; }
