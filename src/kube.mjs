import { spawn } from "node:child_process";

/**
 * Run kubectl without a shell. Arguments go straight to execve, so nothing the
 * model writes is ever interpreted by sh. HOME points at an empty directory so
 * a stray ~/.kube/config on the host is never picked up.
 */
export function kubectl(kubeconfig, args, { timeoutMs = 60000, input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("kubectl", ["--kubeconfig", kubeconfig, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.KUBE_HOME || "/tmp/agentops-home" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });
}

export async function kjson(kubeconfig, args) {
  const r = await kubectl(kubeconfig, [...args, "-o", "json"]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export async function must(kubeconfig, args, opts) {
  const r = await kubectl(kubeconfig, args, opts);
  if (r.code !== 0) throw new Error(`kubectl ${args.join(" ")} failed: ${r.stderr.slice(0, 300)}`);
  return r;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 120000, everyMs = 2000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      // keep polling
    }
    await sleep(everyMs);
  }
  return false;
}

/** A deployment whose current template is fully rolled out and Ready. */
export async function deployHealthy(kc, name, ns = "shop") {
  const d = await kjson(kc, ["get", "deployment", name, "-n", ns]);
  if (!d) return false;
  const want = d.spec.replicas ?? 1;
  const s = d.status || {};
  if ((s.observedGeneration ?? 0) < d.metadata.generation) return false;
  if (want === 0) return false;
  return (
    (s.updatedReplicas ?? 0) === want &&
    (s.readyReplicas ?? 0) === want &&
    (s.availableReplicas ?? 0) === want &&
    !s.unavailableReplicas &&
    (s.replicas ?? 0) === want
  );
}

export async function podsOf(kc, app, ns = "shop") {
  const p = await kjson(kc, ["get", "pods", "-n", ns, "-l", `app=${app}`]);
  return p ? p.items : [];
}
