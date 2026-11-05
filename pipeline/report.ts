// Records the result publicly. Holds the Supabase service key, never runs generated code.
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { recordSpend, type Usage } from "./lib/spend.ts";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const outcome = existsSync(".candidate/outcome.json")
  ? JSON.parse(readFileSync(".candidate/outcome.json", "utf8"))
  : { title: "Change not built", notes: "" };
// A repaired build has a second candidate, so both attempts count.
const used = [".candidate/usage.json", ".candidate-first/usage.json"]
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, "utf8")) as Usage);
await recordSpend(db, "build", {
  input: used.reduce((sum, u) => sum + u.input, 0),
  output: used.reduce((sum, u) => sum + u.output, 0),
});

const failure = existsSync("failure.txt") ? readFileSync("failure.txt", "utf8").trim() : "";
const released = process.env.RELEASED === "true";
const version = process.env.VERSION || null;
const ballot = process.env.BALLOT_ID ? Number(process.env.BALLOT_ID) : null;

// Detailed failures can quote generated code, so the public note stays general.
const publicFailure = "The change failed its automated checks after one repair attempt, so it was dropped and the previous version stayed live.";
console.log(failure);

if (ballot) {
  const { error } = await db.rpc("complete_build", {
    p_ballot: ballot,
    p_ok: released,
    p_version: version,
    p_title: outcome.title,
    p_notes: released ? outcome.notes : publicFailure,
  });
  if (error) throw new Error(error.message);
} else if (released) {
  const { error } = await db.from("changes").insert({ kind: "fix", version, title: outcome.title, notes: outcome.notes });
  if (error) throw new Error(error.message);
} else if (process.env.ROLLBACK_TO) {
  const { error } = await db.from("changes").insert({
    kind: "rollback",
    version: process.env.ROLLBACK_TO,
    title: `Rolled back to ${process.env.ROLLBACK_TO}`,
    notes: process.env.ROLLBACK_REASON ?? "",
  });
  if (error) throw new Error(error.message);
}
