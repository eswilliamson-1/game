// Checks the isolation that only exists on the real host. Needs no secrets.
import { readFileSync } from "node:fs";
import settings from "../config/settings.json" with { type: "json" };

export type Check = { name: string; ok: boolean; detail: string };

/** Reads the policy from the file deployed to the host, so the two can't drift. */
export function expectedPolicy(htaccess: string): string[] {
  const match = htaccess.match(/Content-Security-Policy "([^"]+)"/);
  if (!match) throw new Error("No security policy found in the host config.");
  return match[1].split(";").map((d) => d.trim());
}

export function checkPolicy(name: string, header: string | null, expected: string[]): Check {
  const live = (header ?? "").split(/[;,]/).map((d) => d.trim());
  const missing = expected.filter((directive) => !live.includes(directive));
  return { name, ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join("; ")}` : "all directives present" };
}

async function get(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
}

export async function verifyLive(): Promise<Check[]> {
  const checks: Check[] = [];
  const expected = expectedPolicy(readFileSync("sandbox-host/.htaccess", "utf8"));

  const game = await get(`https://${settings.hosts.game}/`);
  checks.push({ name: "Game host responds", ok: game.status === 200, detail: `status ${game.status}` });
  checks.push(checkPolicy("Game security policy", game.headers.get("content-security-policy"), expected));
  const vote = await get(`https://${settings.hosts.vote}/`);
  const frameBlocked = (vote.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'");
  checks.push({ name: "Voting site can't be framed", ok: frameBlocked, detail: frameBlocked ? "blocked" : "no frame-ancestors policy" });

  for (const url of settings.mustBeBlocked) {
    const response = await get(url);
    const blocked = [403, 404].includes(response.status);
    checks.push({ name: `Blocked on main domain: ${url}`, ok: blocked, detail: `status ${response.status}` });
  }

  const config = await get(`https://${settings.hosts.game}/.htaccess`);
  checks.push({ name: "Host config isn't public", ok: config.status !== 200, detail: `status ${config.status}` });
  return checks;
}

if (process.argv[1]?.endsWith("verify-live.ts")) {
  const checks = await verifyLive();
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name} (${c.detail})`);
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}
