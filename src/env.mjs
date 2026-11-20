import { kubectl, kjson, must, deployHealthy, waitFor } from "./kube.mjs";

const BASE = new URL("../cluster/base.yaml", import.meta.url).pathname;
const RBAC = new URL("../cluster/rbac.yaml", import.meta.url).pathname;

/**
 * Put cluster i back to the clean baseline: delete both app namespaces,
 * undo any node change, re-apply the manifests and wait until every
 * deployment is Ready. Every incident starts from here.
 */
export async function reset(kc) {
  await kubectl(kc, ["delete", "namespace", "shop", "payments", "--ignore-not-found", "--wait=true", "--timeout=120s"], { timeoutMs: 150000 });
  const nodes = await kjson(kc, ["get", "nodes"]);
  for (const n of nodes?.items || []) {
    if (n.spec.unschedulable) await must(kc, ["uncordon", n.metadata.name]);
    if ((n.spec.taints || []).length) await must(kc, ["patch", "node", n.metadata.name, "--type=json", "-p", '[{"op":"remove","path":"/spec/taints"}]']);
  }
  await must(kc, ["apply", "-f", BASE]);
  await must(kc, ["apply", "-f", RBAC]);
  const ok = await waitFor(
    async () =>
      (await deployHealthy(kc, "web")) &&
      (await deployHealthy(kc, "api")) &&
      (await deployHealthy(kc, "worker")) &&
      (await deployHealthy(kc, "cache")) &&
      (await deployHealthy(kc, "payments-api", "payments")),
    { timeoutMs: 180000 },
  );
  if (!ok) throw new Error("baseline did not become healthy");
}

export function clusterFiles(i) {
  const dir = new URL(`../run/`, import.meta.url).pathname;
  return {
    admin: `${dir}kc-admin-${i}`,
    guarded: `${dir}kc-agent-${i}`,
    unguarded: `${dir}kc-unguarded-${i}`,
    killSwitch: `${dir}kill-switch-${i}`,
    node: `agentops-${i}-control-plane`,
  };
}
