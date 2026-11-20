// Replay every recorded kubectl command through the hardened gate (src/guard.mjs)
// and compare with what happened when the run was recorded: list every command
// that ran then and would be refused now, or the other way round. No cluster, no model.
//
// The check on the dry-run result (checkResult) needs a live API server, so it
// cannot be replayed here; instead this lists every executed patch, scale, set
// and rollout command in the guarded arm so the result check can be argued
// command by command.
//
//   node scripts/05-replay-guard.mjs data/runs.jsonl > results/replay-guard.txt
import { readFileSync } from "node:fs";
import * as v2 from "../src/guard.mjs";

const file = process.argv[2] || "data/runs.jsonl";
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function decide(g, args, arm, mutationsSoFar) {
  const denied = g.hostDeny(args);
  if (denied) return "host-deny";
  const p = g.parse(args);
  if (!g.isMutation(p)) return "read";
  if (arm === "unguarded") return "run";
  const d = g.decideGuarded(p, { mutationsSoFar });
  return d ? `${d.approval ? "approval" : "refused"}:${d.guard}` : "run";
}
const RAN = (d) => d === "read" || d === "run";

let total = 0;
const diffs = [];
const resultChecked = [];
for (const r of rows) {
  let executed = 0;
  for (const e of r.audit) {
    if (e.tool !== "kubectl" || e.decision === "bad-json") continue;
    total++;
    // What actually happened when it was recorded: ran (read or executed) or not.
    const before = ["read", "executed"].includes(e.decision) ? (e.decision === "read" ? "read" : "run") : e.decision;
    const after = decide(v2, e.args, r.arm, executed);
    if (RAN(before) !== RAN(after))
      diffs.push({ key: r.key, at: Math.round(e.at / 1000), recorded: e.decision, code: e.code, before, after, args: e.args.join(" ").slice(0, 160) });
    if (e.decision === "executed") {
      executed++;
      if (r.arm === "guarded" && ["patch", "scale", "set", "rollout"].includes(v2.parse(e.args).verb))
        resultChecked.push({ key: r.key, args: e.args.join(" ").slice(0, 200) });
    }
  }
}

const changedRan = diffs.filter((d) => RAN(d.before) && !RAN(d.after));
const changedRanOk = changedRan.filter((d) => d.code === 0);
console.log(`${total} recorded kubectl commands replayed from ${file}`);
console.log(`${diffs.length} decisions differ between the recorded gate and the hardened one`);
console.log(`  ${changedRan.length} ran then and would be refused now; ${changedRanOk.length} of those had exit code 0 when they ran`);
console.log(`  ${diffs.filter((d) => !RAN(d.before) && RAN(d.after)).length} were refused then and would run now`);
console.log();
for (const d of diffs) console.log(`${d.key} @${d.at}s recorded=${d.recorded}${d.code !== undefined ? ` exit=${d.code}` : ""} now=${d.after} :: kubectl ${d.args}`);
console.log();
console.log(`${resultChecked.length} executed guarded patch/scale/set/rollout commands (subject to the new dry-run result check):`);
for (const x of resultChecked) console.log(`  ${x.key} :: kubectl ${x.args}`);
