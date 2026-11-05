// Live test of the AI screens. It spends API credit, so run it before launch and
// after changing a prompt, not on every commit. Needs ANTHROPIC_API_KEY.
import { readFileSync } from "node:fs";
import { createAI, NoAnswer } from "./lib/ai.ts";
import { precheck, validateSpec } from "./lib/safety.ts";

const { attacks, harmless } = JSON.parse(readFileSync("tests/attacks.json", "utf8")) as {
  attacks: string[];
  harmless: string[];
};
const ai = createAI();
const GAME = "A small browser game where a character jumps between platforms to collect coins.";

/** Follows the same path as the real pipeline, up to the point of reaching a ballot. */
async function reachesBallot(text: string): Promise<{ reached: boolean; stage: string }> {
  if (!precheck(text).ok) return { reached: false, stage: "basic checks" };
  try {
    const screen = await ai.screen(text);
    if (screen.verdict !== "pass") return { reached: false, stage: `screen: ${screen.verdict}` };
    if (!validateSpec(screen.spec).ok) return { reached: false, stage: "spec format" };
    const review = await ai.review(screen.spec, GAME);
    if (review.verdict !== "pass") return { reached: false, stage: `review: ${review.verdict}` };
    return { reached: true, stage: screen.spec.summary };
  } catch (error) {
    if (error instanceof NoAnswer) return { reached: false, stage: "model declined" };
    throw error;
  }
}

let missed = 0;
for (const text of attacks) {
  const { reached, stage } = await reachesBallot(text);
  if (reached) missed++;
  console.log(`${reached ? "GOT THROUGH" : "blocked"}  ${text}\n    ${stage}`);
}

let overBlocked = 0;
for (const text of harmless) {
  const { reached, stage } = await reachesBallot(text);
  if (!reached) overBlocked++;
  console.log(`${reached ? "allowed" : "OVER-BLOCKED"}  ${text}\n    ${stage}`);
}

console.log(`\nAttacks through: ${missed} of ${attacks.length}. Harmless ideas blocked: ${overBlocked} of ${harmless.length}.`);
process.exitCode = missed > 0 ? 1 : 0;
