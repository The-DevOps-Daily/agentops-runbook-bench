// Run the incident matrix: models x arms x incidents x repetitions, one kind
// cluster per worker. Resumable: finished keys in the output file are skipped.
//
//   node scripts/01-run.mjs --models anthropic-claude-5.5-haiku --arms guarded,unguarded --reps 3 --clusters 6 --out data/runs.jsonl
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { SCENARIOS } from "../src/scenarios.mjs";
import { runAgent } from "../src/agent.mjs";
import { snapshot, globalHarm } from "../src/state.mjs";
import { reset, clusterFiles } from "../src/env.mjs";
import { waitFor, sleep } from "../src/kube.mjs";
import { stamp } from "../src/stamp.mjs";
import { mulberry32, shuffle } from "../src/rng.mjs";

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const models = (argv.models || "anthropic-claude-5.5-haiku").split(",");
const arms = (argv.arms || "guarded,unguarded").split(",");
const reps = Number(argv.reps || 1);
const clusters = Number(argv.clusters || 1);
const firstCluster = Number(argv["first-cluster"] || 1);
const only = argv.only ? argv.only.split(",") : null;
const out = argv.out || "data/runs.jsonl";
const apiKey = process.env.DO_INFERENCE_KEY;
if (!apiKey) throw new Error("DO_INFERENCE_KEY is not set (see .env.example)");

// One writer per file.
const lock = `${out}.lock`;
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  try {
    process.kill(pid, 0);
    throw new Error(`${out} is being written by pid ${pid}`);
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}
writeFileSync(lock, String(process.pid));
process.on("exit", () => existsSync(lock) && unlinkSync(lock));

const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key)
    : [],
);

const jobs = [];
for (const model of models)
  for (const arm of arms)
    for (const s of SCENARIOS)
      for (let rep = 1; rep <= reps; rep++) {
        if (only && !only.includes(s.id)) continue;
        const key = `${model}|${arm}|${s.id}|${rep}`;
        if (!done.has(key)) jobs.push({ key, model, arm, scenario: s, rep });
      }
const queue = shuffle(mulberry32(20261123), jobs);
console.log(`${queue.length} runs to do (${done.size} already in ${out})`);

async function runOne(job, i) {
  const f = clusterFiles(i);
  const s = job.scenario;
  rmSync(f.killSwitch, { force: true });
  const rec = { key: job.key, stamp: stamp(job.model), model: job.model, arm: job.arm, scenario: s.id, expect: s.expect, rep: job.rep, cluster: i };
  rec.startedAt = new Date().toISOString();
  const tSetup = Date.now();
  await reset(f.admin);
  await s.break(f.admin);
  rec.brokenOk = await waitFor(() => s.broken(f.admin), { timeoutMs: s.brokenTimeoutMs || 120000 });
  rec.setupMs = Date.now() - tSetup;
  if (!rec.brokenOk) {
    rec.setupError = "break did not become visible";
    return rec;
  }
  const before = await snapshot(f.admin);
  rec.fixedAtStart = await s.fixed(f.admin);

  // Poll the fix check while the agent works, for time to fix.
  const t0 = Date.now();
  let fixedSince = null;
  let polling = true;
  const timeline = [];
  const poller = (async () => {
    while (polling) {
      const ok = await s.fixed(f.admin).catch(() => false);
      const at = Date.now() - t0;
      if (ok && fixedSince === null) fixedSince = at;
      if (!ok) fixedSince = null;
      timeline.push([at, ok ? 1 : 0]);
      await sleep(3000);
    }
  })();

  const alert = s.alert.replace("{node}", f.node);
  const result = await runAgent({
    apiKey,
    model: job.model,
    arm: job.arm,
    alert,
    kubeconfig: job.arm === "guarded" ? f.guarded : f.unguarded,
    killSwitchFile: f.killSwitch,
  });
  // Give a rollout the agent started up to 90 s to finish before the final check.
  const executed = result.audit.filter((e) => e.decision === "executed").length;
  if (executed > 0) await waitFor(() => s.fixed(f.admin), { timeoutMs: 90000, everyMs: 3000 });
  polling = false;
  await poller;
  rec.fixedFinal = await s.fixed(f.admin);
  rec.ttfMs = rec.fixedFinal && fixedSince !== null ? fixedSince : null;
  rec.timeline = timeline;
  const after = await snapshot(f.admin);
  const g = globalHarm(before, after, s);
  rec.harm = [...g.harm, ...(s.harm ? await s.harm(f.admin) : [])];
  rec.collateral = g.collateral;
  rec.alert = alert;
  Object.assign(rec, result);
  return rec;
}

for (let k = firstCluster; k < firstCluster + clusters; k++) {
  if (!existsSync(clusterFiles(k).admin)) throw new Error(`cluster ${k} has no kubeconfig in run/; create it with scripts/00-setup-clusters.sh`);
}

let next = 0;
async function worker(i) {
  while (next < queue.length) {
    const job = queue[next++];
    const t = Date.now();
    let rec;
    try {
      rec = await runOne(job, i);
    } catch (e) {
      rec = { key: job.key, model: job.model, arm: job.arm, scenario: job.scenario.id, rep: job.rep, cluster: i, harnessError: String(e.message || e) };
    }
    if (rec.harnessError || rec.setupError) {
      console.log(`[c${i}] ${job.key} HARNESS ${rec.harnessError || rec.setupError} (not recorded, will retry on next start)`);
      appendFileSync(`${out}.errors`, JSON.stringify(rec) + "\n");
      continue;
    }
    appendFileSync(out, JSON.stringify(rec) + "\n");
    const ex = rec.audit.filter((e) => e.decision === "executed").length;
    const bl = rec.audit.filter((e) => ["refused", "approval-required"].includes(e.decision)).length;
    console.log(
      `[c${i}] ${job.key} fixed=${rec.fixedFinal} esc=${rec.escalations.length} exec=${ex} blocked=${bl} harm=${rec.harm.length} steps=${rec.steps} ${Math.round((Date.now() - t) / 1000)}s${rec.error ? " ERR " + rec.error.slice(0, 80) : ""}`,
    );
  }
}

await Promise.all(Array.from({ length: clusters }, (_, k) => worker(firstCluster + k)));
console.log("done");
