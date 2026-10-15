import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { delimiter } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mergePath, parseMarkedPath, readLoginShellPath } from "./login-shell-path.js";

const MARKER = "__PIZZA_LOGIN_SHELL_PATH__";
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const dir = mkdtempSync(path.join(tmpdir(), "login-shell-path-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** A stand-in shell that ignores its arguments and runs `body` instead. */
function fakeShell(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** Absolute path of an installed shell, or undefined to skip its suite. */
function installed(name: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const shellPath = found.stdout.trim();
  return found.status === 0 && shellPath.startsWith("/") ? shellPath : undefined;
}

/** Spawns with a scratch env so only the test's rc files run, never the developer's. */
function withEnv(env: NodeJS.ProcessEnv): typeof spawn {
  return ((command: string, args: string[], options: object) =>
    spawn(command, args, { ...options, env })) as unknown as typeof spawn;
}

function scratchHome(name: string, files: Record<string, string>): string {
  const home = path.join(dir, name);
  mkdirSync(home, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(home, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${body}\n`);
  }
  return home;
}

function entriesOf(value: string | undefined): string[] {
  return value?.split(":") ?? [];
}

describe("parseMarkedPath", () => {
  it("ignores rc-file noise around the markers", () => {
    expect(parseMarkedPath(`Welcome!\n${MARKER}\n/a:/b\n${MARKER}\nbye\n`)).toBe("/a:/b");
  });

  it("rejects output without both markers or with an empty PATH", () => {
    expect(parseMarkedPath(`${MARKER}\n/a:/b\n`)).toBeUndefined();
    expect(parseMarkedPath(`${MARKER}\n\n${MARKER}\n`)).toBeUndefined();
  });
});

describe("mergePath", () => {
  it("puts shell entries first and keeps launch-only entries, without duplicates", () => {
    const shell = ["/opt/tools/bin", "/usr/bin", "/bin"].join(delimiter);
    const launch = ["/usr/bin", "/bin", "/app/bin"].join(delimiter);
    expect(mergePath(shell, launch)).toBe(
      ["/opt/tools/bin", "/usr/bin", "/bin", "/app/bin"].join(delimiter),
    );
  });

  it("tolerates an unset launch PATH and empty segments", () => {
    expect(mergePath(`/a${delimiter}${delimiter}/b`, undefined)).toBe(`/a${delimiter}/b`);
  });
});

describe.skipIf(process.platform === "win32")("readLoginShellPath", () => {
  it("returns the PATH the shell prints between markers", async () => {
    const shell = fakeShell(
      "ok.sh",
      `echo banner; echo ${MARKER}; echo /opt/tools/bin:/usr/bin; echo ${MARKER}`,
    );
    await expect(readLoginShellPath({ shell })).resolves.toBe("/opt/tools/bin:/usr/bin");
  });

  it("returns at the closing marker while a backgrounded job still holds stdout", async () => {
    const shell = fakeShell(
      "background.sh",
      `sleep 30 & echo ${MARKER}; echo /opt/tools/bin; echo ${MARKER}`,
    );
    const started = Date.now();
    await expect(readLoginShellPath({ shell })).resolves.toBe("/opt/tools/bin");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives up on a shell that hangs", async () => {
    const shell = fakeShell("hang.sh", "trap '' TERM; sleep 30");
    const started = Date.now();
    await expect(readLoginShellPath({ shell, timeoutMs: 200 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("returns undefined when the shell cannot be spawned", async () => {
    await expect(
      readLoginShellPath({ shell: path.join(dir, "missing-shell") }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op on Windows", async () => {
    await expect(readLoginShellPath({ platform: "win32", shell: "/bin/sh" })).resolves.toBeUndefined();
  });
});

const zsh = installed("zsh");
const bash = installed("bash");
const fish = installed("fish");

describe.skipIf(!zsh)("readLoginShellPath with a real zsh", () => {
  const read = (home: string, timeoutMs?: number) =>
    readLoginShellPath({
      shell: zsh,
      ...(timeoutMs ? { timeoutMs } : {}),
      spawnShell: withEnv({ HOME: home, ZDOTDIR: home, PATH: BARE_PATH, EXPECTED_PWD: homedir() }),
    });

  it("collects PATH from .zshenv, .zprofile, and .zshrc", async () => {
    const home = scratchHome("zsh-startup-files", {
      ".zshenv": "export PATH=/from/zshenv:$PATH",
      ".zprofile": "export PATH=/from/zprofile:$PATH",
      ".zshrc": "export PATH=/from/zshrc:$PATH",
    });
    expect(entriesOf(await read(home))).toEqual(
      expect.arrayContaining(["/from/zshenv", "/from/zprofile", "/from/zshrc"]),
    );
  });

  it("survives banners, aliases, functions, and prompts in .zshrc", async () => {
    const home = scratchHome("zsh-noisy", {
      ".zshrc": [
        "echo 'Welcome back!'",
        "alias printenv='echo hijacked'",
        "alias printf='echo hijacked'",
        "echo() { builtin echo hijacked; }",
        "read -r answer",
        "export PATH=/from/zshrc:$PATH",
      ].join("\n"),
    });
    const value = await read(home);
    expect(entriesOf(value)).toContain("/from/zshrc");
    expect(value).not.toContain("hijacked");
  });

  it("does not wait on a server process .zshrc leaves running", async () => {
    const home = scratchHome("zsh-background", {
      ".zshrc": "sleep 30 &!\nexport PATH=/from/zshrc:$PATH",
    });
    const started = Date.now();
    expect(entriesOf(await read(home))).toContain("/from/zshrc");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("starts in the home directory, where version managers find global tools", async () => {
    // Stands in for `eval "$(mise activate zsh)"`, which resolves versions from $PWD.
    const home = scratchHome("zsh-version-manager", {
      ".zshrc": '[ "$PWD" = "$EXPECTED_PWD" ] && export PATH=/global/tools/bin:$PATH',
    });
    expect(entriesOf(await read(home))).toContain("/global/tools/bin");
  });

  it("falls back when .zshrc replaces the shell or never finishes", async () => {
    const execHome = scratchHome("zsh-exec", { ".zshrc": "exec /bin/sh -c 'echo replaced'" });
    await expect(read(execHome)).resolves.toBeUndefined();
    const slowHome = scratchHome("zsh-slow", { ".zshrc": "sleep 30" });
    await expect(read(slowHome, 300)).resolves.toBeUndefined();
  });
});

describe.skipIf(!bash)("readLoginShellPath with a real bash", () => {
  const read = (home: string) =>
    readLoginShellPath({ shell: bash, spawnShell: withEnv({ HOME: home, PATH: BARE_PATH }) });

  it("reads .bashrc when .bash_profile sources it", async () => {
    const home = scratchHome("bash-sourced", {
      ".bash_profile": "export PATH=/from/bash_profile:$PATH\n. ~/.bashrc",
      ".bashrc": "alias printenv='echo hijacked'\nexport PATH=/from/bashrc:$PATH",
    });
    const value = await read(home);
    expect(entriesOf(value)).toEqual(
      expect.arrayContaining(["/from/bash_profile", "/from/bashrc"]),
    );
    expect(value).not.toContain("hijacked");
  });

  it("matches a login terminal, which skips a .bashrc that .bash_profile does not source", async () => {
    const home = scratchHome("bash-unsourced", {
      ".bash_profile": "export PATH=/from/bash_profile:$PATH",
      ".bashrc": "export PATH=/from/bashrc:$PATH",
    });
    const entries = entriesOf(await read(home));
    expect(entries).toContain("/from/bash_profile");
    expect(entries).not.toContain("/from/bashrc");
  });
});

describe.skipIf(!fish)("readLoginShellPath with a real fish", () => {
  it("prints fish's list PATH colon-separated", async () => {
    const home = scratchHome("fish-config", {
      ".config/fish/config.fish": "set -gx PATH /from/fish $PATH",
    });
    const value = await readLoginShellPath({
      shell: fish,
      spawnShell: withEnv({
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        PATH: BARE_PATH,
      }),
    });
    expect(entriesOf(value)).toContain("/from/fish");
  });
});
