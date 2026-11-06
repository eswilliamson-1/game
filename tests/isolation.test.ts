import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GAME_CSP } from "../pipeline/check.ts";
import { checkPolicy, expectedPolicy } from "../pipeline/verify-live.ts";
import settings from "../config/settings.json" with { type: "json" };

const htaccess = readFileSync("sandbox-host/.htaccess", "utf8");
const policy = expectedPolicy(htaccess);

test("the play test uses the same policy as the live host", () => {
  for (const directive of GAME_CSP.split(";").map((d) => d.trim())) {
    assert.ok(policy.includes(directive), directive);
  }
});

test("the host config matches the configured hosts", () => {
  assert.ok(policy.includes(`frame-ancestors https://${settings.hosts.vote}`));
  assert.ok(htaccess.includes(settings.hosts.game.replaceAll(".", "\\.")));
});

test("the account save file only talks to the voting site", () => {
  const file = readFileSync("sandbox-host/account-save.js", "utf8");
  assert.ok(file.includes(`"https://${settings.hosts.vote}"`));
  assert.ok(!file.includes('"*"'));
});

test("the policy blocks the network and keeps the sandbox", () => {
  assert.ok(policy.includes("connect-src 'none'"));
  assert.ok(policy.includes("default-src 'none'"));
  assert.ok(policy.includes("sandbox allow-scripts allow-same-origin allow-pointer-lock"));
  assert.ok(!policy.join(" ").includes("unsafe"));
});

test("a missing or weakened live policy is detected", () => {
  assert.equal(checkPolicy("x", null, policy).ok, false);
  assert.equal(checkPolicy("x", "upgrade-insecure-requests", policy).ok, false);
  assert.equal(checkPolicy("x", policy.join("; ").replace("connect-src 'none'", "connect-src *"), policy).ok, false);
});

test("the live policy passes even with Hostinger's extra header merged in", () => {
  assert.equal(checkPolicy("x", `upgrade-insecure-requests, ${policy.join("; ")}`, policy).ok, true);
});

test("the live game is never served from a stale cache", () => {
  assert.ok(htaccess.includes('Cache-Control "no-cache"'));
});

test("only the numbers of a move get through, and only within range", async () => {
  // @ts-expect-error The site scripts are plain JavaScript.
  const { cleanMove } = await import("../shell/world-bridge.js");
  const good = { x: 1.234, y: -2, z: 0, heading: 3, action: 31 };
  assert.deepEqual(cleanMove({ ...good, note: "hello", name: "eric" }), { x: 1.23, y: -2, z: 0, heading: 3, action: 31 });
  for (const bad of [null, "hi", {}, { ...good, x: "1" }, { ...good, y: NaN }, { ...good, z: Infinity }, { ...good, x: 100001 }, { ...good, action: 32 }, { ...good, action: 1.5 }, { ...good, action: -1 }]) {
    assert.equal(cleanMove(bad), null);
  }
});
