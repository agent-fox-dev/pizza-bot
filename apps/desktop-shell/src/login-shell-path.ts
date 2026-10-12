/**
 * Recovers the user's shell PATH for a GUI launch. macOS starts Dock/Finder apps
 * with launchd's bare PATH, so bare stdio MCP commands would otherwise ENOENT.
 */
import { spawn } from "node:child_process";
import { delimiter } from "node:path";

const MARKER = "__PIZZA_LOGIN_SHELL_PATH__";

export interface LoginShellPathOptions {
  platform?: NodeJS.Platform;
  shell?: string;
  timeoutMs?: number;
  spawnShell?: typeof spawn;
}

/** Returns the PATH an interactive login shell exports, or undefined on any failure. */
export function readLoginShellPath(opts: LoginShellPathOptions = {}): Promise<string | undefined> {
  // Windows GUI apps already receive the user's full PATH.
  if ((opts.platform ?? process.platform) === "win32") return Promise.resolve(undefined);
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const spawnShell = opts.spawnShell ?? spawn;

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // `-i` too: many users extend PATH in .zshrc/.bashrc, which login-only skips.
    // Markers fence off banners and other rc-file output.
    const child = spawnShell(
      shell,
      ["-i", "-l", "-c", `echo ${MARKER}; printenv PATH; echo ${MARKER}`],
      // Own session, no controlling terminal: an interactive shell launched from a
      // terminal would otherwise seize that terminal's job control.
      { stdio: ["ignore", "pipe", "ignore"], detached: true },
    );
    // Interactive shells ignore SIGTERM; a hung rc file needs SIGKILL. Resolve
    // regardless, since a backgrounded rc job can hold stdout open past the kill.
    const timer = setTimeout(() => {
      killGroup(child.pid);
      finish(undefined);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(parseMarkedPath(stdout)));
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export function parseMarkedPath(stdout: string): string | undefined {
  const parts = stdout.split(MARKER);
  if (parts.length < 3) return undefined;
  const value = parts[1]!.trim();
  return value.length > 0 ? value : undefined;
}

/** Shell entries first (they reflect the user's intent), then any current-only entries. */
export function mergePath(shellPath: string, current: string | undefined): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...shellPath.split(delimiter), ...(current ?? "").split(delimiter)]) {
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(delimiter);
}
