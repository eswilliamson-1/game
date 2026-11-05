// Estimates what each run spent on the Claude API. It never stops a run if the
// record can't be saved, because the estimate isn't worth failing a release over.
import type { SupabaseClient } from "@supabase/supabase-js";
import settings from "../../config/settings.json" with { type: "json" };

export type Usage = { input: number; output: number };

export function dollars({ input, output }: Usage): number {
  const { inputPerMillion, outputPerMillion } = settings.aiPrice;
  return (input * inputPerMillion + output * outputPerMillion) / 1_000_000;
}

export async function recordSpend(db: SupabaseClient, job: string, usage: Usage): Promise<void> {
  if (usage.input + usage.output === 0) return;
  const { error } = await db.from("ai_spend").insert({
    job,
    input_tokens: usage.input,
    output_tokens: usage.output,
    dollars: dollars(usage),
  });
  if (error) console.error(`Couldn't record AI spending: ${error.message}`);
}
