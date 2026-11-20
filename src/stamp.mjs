import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * A fingerprint of everything that can change an outcome. Every recorded run
 * carries it and the scorer refuses a file with more than one stamp per model,
 * so a stale runner writing into a new file shows up instead of blending in.
 */
const INPUTS = [
  "src/agent.mjs", "src/guard.mjs", "src/scenarios.mjs", "src/state.mjs", "src/kube.mjs", "src/env.mjs",
  "RUNBOOK.md", "cluster/base.yaml", "cluster/rbac.yaml",
];

export function stamp(model) {
  const h = createHash("sha256");
  h.update(model);
  for (const f of INPUTS) h.update(readFileSync(new URL(`../${f}`, import.meta.url)));
  return h.digest("hex").slice(0, 12);
}
