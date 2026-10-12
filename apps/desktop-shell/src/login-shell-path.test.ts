import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mergePath, parseMarkedPath, readLoginShellPath } from "./login-shell-path.js";

const MARKER = "__PIZZA_LOGIN_SHELL_PATH__";
const dir = mkdtempSync(path.join(tmpdir(), "login-shell-path-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** A stand-in shell that ignores its arguments and runs `body` instead. */
function fakeShell(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
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
