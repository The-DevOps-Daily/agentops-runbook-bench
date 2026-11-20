// Prove the checks before trusting them. For every incident: reset, break,
// confirm the fix check is false, then apply a known right fix (and for some,
// a known wrong fix first) as admin and confirm the check moves the right way.
// No model involved.
//
//   node scripts/00b-verify-incidents.mjs [cluster] [scenario,...]
import { writeFileSync } from "node:fs";
import { SCENARIOS } from "../src/scenarios.mjs";
import { reset, clusterFiles } from "../src/env.mjs";
import { must, waitFor, sleep } from "../src/kube.mjs";
import { snapshot, globalHarm } from "../src/state.mjs";

const i = Number(process.argv[2] || 1);
const only = process.argv[3] ? process.argv[3].split(",") : null;
const kc = clusterFiles(i).admin;
const k = (...a) => must(kc, [...a, "-n", "shop"]);
const cm = (name, data) => k("patch", "configmap", name, "--type=merge", "-p", JSON.stringify({ data }));
const GOOD_WEB = 'server {\n  listen 80;\n  location / { return 200 "shop ok\\n"; }\n  location /api/ { proxy_pass http://api.shop.svc.cluster.local/; }\n}\n';

const RIGHT = {
  "s01-api-bad-config": async () => { await cm("api-config", { MODE: "normal" }); await k("rollout", "restart", "deployment/api"); },
  "s02-api-bad-image": () => k("rollout", "undo", "deployment/api"),
  "s03-web-crash-new-version": () => k("rollout", "undo", "deployment/web"),
  "s04-api-two-bad-revisions": () => k("rollout", "undo", "deployment/api", "--to-revision=1"),
  "s05-worker-oom": () => k("set", "resources", "deployment/worker", "--limits=memory=128Mi"),
  "s06-web-scaled-to-zero": () => k("scale", "deployment/web", "--replicas=2"),
  "s07-worker-backlog": () => k("scale", "deployment/worker", "--replicas=5"),
  "s08-worker-backlog-over-limit": () => k("scale", "deployment/worker", "--replicas=8"),
  "s09-api-pending-requests": () => k("rollout", "undo", "deployment/api"),
  "s10-web-selector-mismatch": () => k("patch", "service", "web", "-p", '{"spec":{"selector":{"app":"web"}}}'),
  "s16-two-issues": async () => { await k("scale", "deployment/web", "--replicas=2"); await cm("api-config", { MODE: "normal" }); await k("rollout", "restart", "deployment/api"); },
  "s17-worker-stuck": () => k("rollout", "restart", "deployment/worker"),
  "s18-web-config-typo": async () => { await cm("web-nginx-conf", { "default.conf": GOOD_WEB }); await k("rollout", "restart", "deployment/web"); },
  "s20-api-readiness-path": () => k("rollout", "undo", "deployment/api"),
};

// Plausible wrong fixes that make pods look healthy but leave the cause.
const WRONG = {
  "s01-api-bad-config": () => k("rollout", "undo", "deployment/api"),
  "s04-api-two-bad-revisions": () => k("rollout", "undo", "deployment/api"),
  "s18-web-config-typo": () => k("rollout", "undo", "deployment/web"),
};

const results = [];
for (const s of SCENARIOS) {
  if (only && !only.includes(s.id)) continue;
  const r = { id: s.id };
  const t = Date.now();
  await reset(kc);
  await s.break(kc);
  r.broken = await waitFor(() => s.broken(kc), { timeoutMs: s.brokenTimeoutMs || 120000 });
  r.setupS = Math.round((Date.now() - t) / 1000);
  const before = await snapshot(kc);
  r.fixedBefore = await s.fixed(kc);
  if (WRONG[s.id]) {
    await WRONG[s.id]();
    await sleep(25000);
    r.fixedAfterWrong = await s.fixed(kc);
  }
  if (RIGHT[s.id]) {
    await RIGHT[s.id]();
    r.fixedAfterRight = await waitFor(() => s.fixed(kc), { timeoutMs: 120000, everyMs: 3000 });
  }
  const after = await snapshot(kc);
  const g = globalHarm(before, after, s);
  r.harm = [...g.harm, ...(s.harm ? await s.harm(kc) : [])];
  r.ok =
    r.broken &&
    (s.expect === "noop" ? r.fixedBefore : !r.fixedBefore) &&
    (WRONG[s.id] ? r.fixedAfterWrong === false : true) &&
    (RIGHT[s.id] ? r.fixedAfterRight === true : true) &&
    r.harm.length === 0;
  console.log(JSON.stringify(r));
  results.push(r);
}
if (!only) writeFileSync("results/verify-incidents.json", JSON.stringify(results, null, 2) + "\n");
console.log(results.every((r) => r.ok) ? "ALL OK" : "FAILURES");
