import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("pipeline/verify-release.sh");

function run(cwd: string, command: string, ...args: string[]) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

/** Makes a repo with one commit, applies a release commit, and runs the check. */
function release(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  try {
    const git = (...args: string[]) => run(dir, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args);
    git("init", "-q");
    mkdirSync(join(dir, "game"));
    mkdirSync(join(dir, "pipeline"));
    writeFileSync(join(dir, "game/index.html"), "old");
    writeFileSync(join(dir, "pipeline/deploy.ts"), "old");
    git("add", ".");
    git("commit", "-qm", "start");
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    git("add", ".");
    git("commit", "-qm", "release", "--allow-empty");
    return run(dir, "bash", SCRIPT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a release that only changes the game passes", () => {
  assert.equal(release({ "game/index.html": "new", "game/game.js": "x" }).status, 0);
});

test("an empty release passes", () => {
  assert.equal(release({}).status, 0);
});

test("a release that changes the framework is blocked", () => {
  const result = release({ "game/index.html": "new", "pipeline/deploy.ts": "changed" });
  assert.equal(result.status, 1);
  assert.match(result.output, /pipeline\/deploy\.ts/);
});

test("a release that adds a file outside the game is blocked", () => {
  assert.equal(release({ "evil.js": "x" }).status, 1);
});

test("a folder with a similar name doesn't count as the game", () => {
  const dir = "game-extra.txt";
  assert.equal(release({ [dir]: "x" }).status, 1);
});
