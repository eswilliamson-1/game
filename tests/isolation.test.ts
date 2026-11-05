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
