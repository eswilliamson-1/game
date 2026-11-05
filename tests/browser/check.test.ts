import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGame } from "../../pipeline/check.ts";
import { writeGame } from "../../pipeline/lib/files.ts";

const HTML = `<!doctype html><html><head><title>Test</title><link rel="stylesheet" href="s.css"></head>
<body><h1 id="goal">Catch the stars</h1><button id="b">Jump</button><script src="game.js"></script></body></html>`;

const GOOD = `
window.gameTest = { inputsHandled: 0, goal: "Catch the stars" };
const handle = () => { window.gameTest.inputsHandled++; };
addEventListener("pointerdown", handle);
addEventListener("keydown", handle);
`;

async function check(js: string, html = HTML) {
  const dir = mkdtempSync(join(tmpdir(), "game-"));
  try {
    writeGame(dir, [
      { path: "index.html", content: html },
      { path: "s.css", content: "body { background: #000; color: #fff; }" },
      { path: "game.js", content: js },
    ]);
    return await checkGame(dir, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hasFailure = (failures: string[], text: RegExp) =>
  assert.ok(failures.some((f) => text.test(f)), `Expected ${text} in ${JSON.stringify(failures)}`);

test("a working game passes", async () => {
  const result = await check(GOOD);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test("a game that never starts fails", async () => {
  hasFailure((await check("// nothing here")).failures, /never started/);
});

test("a game that ignores input fails", async () => {
  hasFailure((await check(`window.gameTest = { inputsHandled: 0, goal: "Catch the stars" };`)).failures, /didn't respond/);
});

test("a game with no goal fails", async () => {
  hasFailure((await check(GOOD.replace('goal: "Catch the stars"', 'goal: ""'))).failures, /no goal/);
});

test("a goal that isn't on screen fails", async () => {
  hasFailure((await check(GOOD.replace('goal: "Catch the stars"', 'goal: "Secret goal"'))).failures, /isn't visible/);
});

test("a script error fails", async () => {
  hasFailure((await check(`${GOOD}\nsetTimeout(() => { missing.value = 1; }, 50);`)).failures, /script error/);
});

test("a slow game fails the frame rate limit", async () => {
  const slow = `${GOOD}
    function spin() { const end = performance.now() + 60; while (performance.now() < end) {} requestAnimationFrame(spin); }
    requestAnimationFrame(spin);`;
  hasFailure((await check(slow)).failures, /FPS/);
});

test("a game that passes the scan still can't reach the network at runtime", async () => {
  const sneaky = `${GOOD}
    const name = ["fet", "ch"].join("");
    globalThis[name]("/secret").catch(() => { throw new Error("blocked"); });`;
  const result = await check(sneaky);
  assert.equal(result.ok, false);
});

test("the scan stops a banned game before it ever runs", async () => {
  const result = await check(`${GOOD}\nfetch("/admin/");`);
  hasFailure(result.failures, /^scan:/);
  assert.deepEqual(result.metrics, {});
});
