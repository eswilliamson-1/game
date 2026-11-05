// Stores the GitHub Actions secrets and variables. Only the owner runs this, in
// their own terminal. Values go straight to GitHub. It skips anything already
// stored, so it's safe to stop and run again later.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const WINDOWS_GH = "C:\\Program Files\\GitHub CLI\\gh.exe";
const GH = existsSync(WINDOWS_GH) ? WINDOWS_GH : "gh";

const SECRETS = [
  ["ANTHROPIC_API_KEY", "Claude API key"],
  ["SUPABASE_SERVICE_KEY", "Supabase service role key"],
  ["SUPABASE_DB_PASSWORD", "Supabase database password"],
  ["GAME_FTP_HOST", "Game FTP host"],
  ["GAME_FTP_USER", "Game FTP username"],
  ["GAME_FTP_PASSWORD", "Game FTP password"],
];
const VARIABLES = [
  ["SUPABASE_URL", "Supabase project URL"],
  ["SUPABASE_ANON_KEY", "Supabase public anon key"],
];

// These prompts show what's pasted, so a password left on the clipboard must not be saved.
const FORMATS: Record<string, RegExp> = {
  SUPABASE_URL: /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/,
  SUPABASE_ANON_KEY: /^(sb_publishable_|eyJ)[\w.-]+$/,
};

const names = (kind: string) =>
  spawnSync(GH, [kind, "list", "--json", "name", "--jq", ".[].name"], { encoding: "utf8" }).stdout.split(/\r?\n/);

const secrets = names("secret");
for (const [name, label] of SECRETS) {
  if (secrets.includes(name)) continue;
  console.log(`\n${label}. What you paste stays hidden.`);
  if (spawnSync(GH, ["secret", "set", name], { stdio: "inherit" }).status !== 0) {
    throw new Error(`${name} wasn't saved. Run this again to continue from here.`);
  }
}

const variables = names("variable");
const input = createInterface({ input: process.stdin, output: process.stdout });
for (const [name, label] of VARIABLES) {
  if (variables.includes(name)) continue;
  const value = (await input.question(`\n${label} (this one is public, and shows as you paste): `)).trim();
  if (!FORMATS[name].test(value)) throw new Error(`That doesn't look like the ${label}, so it wasn't saved. Run this again.`);
  if (spawnSync(GH, ["variable", "set", name, "--body", value], { stdio: "inherit" }).status !== 0) {
    throw new Error(`${name} wasn't saved. Run this again to continue from here.`);
  }
}
input.close();
console.log("\nAll GitHub secrets and variables are stored.");
