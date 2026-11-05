// Runs in GitHub Actions with only the Claude key. It writes generated files
// but never runs them, and it has no way to publish anything.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import settings from "../config/settings.json" with { type: "json" };
import { createAI, NoAnswer, type AI } from "./lib/ai.ts";
import { readGame, writeGame } from "./lib/files.ts";
import { safeGamePath, scanFiles, Spec, validateSpec, type GameFile } from "./lib/safety.ts";

const OUT = ".candidate";

export type Outcome = { ok: boolean; reason: string; title: string; notes: string };

/** Applies generated files on top of the current game, then runs every non-browser check. */
export async function buildCandidate(ai: AI, spec: Spec, current: GameFile[], failure?: string) {
  const fail = (reason: string) => ({ outcome: { ok: false, reason, title: spec.title, notes: "" }, files: [] as GameFile[] });

  const result = await ai.build(spec, current, failure);
  for (const file of result.files) {
    const check = safeGamePath(file.path);
    if (!check.ok) return fail(check.reason);
  }
  const replaced = new Set([...result.files.map((f) => f.path), ...result.deleted]);
  const files = [...current.filter((f) => !replaced.has(f.path)), ...result.files]
    .filter((f) => !f.content.includes("data-placeholder"));

  const violations = scanFiles(files);
  if (violations.length) {
    return fail(`Security scan: ${violations.map((v) => `${v.path}: ${v.problem}`).join("; ")}`);
  }
  const comparison = await ai.compare(spec, current, files);
  if (!comparison.matches_spec) return fail(`Code doesn't match the approved spec: ${comparison.reason}`);

  return { outcome: { ok: true, reason: "", title: result.patch_title, notes: result.patch_notes }, files };
}

async function loadSpec(): Promise<Spec> {
  if (process.env.FIX_DESCRIPTION) {
    // Owner-started fix. Only someone with write access to the repo can trigger this.
    return {
      title: "Bug or security fix",
      summary: process.env.FIX_DESCRIPTION,
      changes: [process.env.FIX_DESCRIPTION],
      player_impact: "The game behaves as intended.",
    };
  }
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const ballotId = Number(process.env.BALLOT_ID);
  const { data, error } = await db.from("ballots").select("status, winner_option_id").eq("id", ballotId).single();
  if (error) throw new Error(error.message);
  if (data.status !== "building") throw new Error(`Ballot ${ballotId} is not waiting to be built.`);
  const option = await db.from("options").select("spec, is_no_change").eq("id", data.winner_option_id).single();
  if (option.error) throw new Error(option.error.message);
  if (option.data.is_no_change) throw new Error("The winning option was no change.");
  const check = validateSpec(option.data.spec);
  if (!check.ok) throw new Error(check.reason);
  return Spec.parse(option.data.spec);
}

async function buildsToday(): Promise<number> {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db
    .from("changes")
    .select("id", { count: "exact", head: true })
    .in("kind", ["vote", "failed"])
    .gte("created_at", since);
  return count ?? 0;
}

async function main() {
  const failure = existsSync("failure.txt") ? readFileSync("failure.txt", "utf8") : undefined;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}/game`, { recursive: true });

  let outcome: Outcome;
  let files: GameFile[] = [];
  try {
    if (!process.env.FIX_DESCRIPTION && (await buildsToday()) >= settings.build.maxBuildsPerDay) {
      throw new NoAnswer("The daily build limit was reached.");
    }
    const spec = await loadSpec();
    ({ outcome, files } = await buildCandidate(createAI(), spec, readGame("game"), failure));
  } catch (error) {
    if (!(error instanceof NoAnswer)) throw error;
    outcome = { ok: false, reason: error.message, title: "Change not built", notes: "" };
  }
  writeGame(`${OUT}/game`, files);
  writeFileSync(`${OUT}/outcome.json`, JSON.stringify(outcome, null, 2));
  console.log(outcome.ok ? "Candidate ready." : `Candidate failed: ${outcome.reason}`);
}

if (process.argv[1]?.endsWith("build.ts")) await main();
