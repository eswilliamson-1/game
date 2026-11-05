// Runs in GitHub Actions with the Claude and Supabase keys. Never runs generated code.
import { createClient } from "@supabase/supabase-js";
import settings from "../config/settings.json" with { type: "json" };
import { createAI } from "./lib/ai.ts";
import { describeGame, readGame } from "./lib/files.ts";
import { runPlan, type Proposal, type Store } from "./lib/plan.ts";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (error) throw new Error(error.message);
  return data as NonNullable<T>;
}

const store: Store = {
  paused: async () => unwrap(await db.from("settings").select("paused").single()).paused,
  pendingProposals: async () =>
    unwrap(await db.from("proposals").select("id, body, reason, spec, title").eq("status", "pending").order("id")) as Proposal[],
  nextQueued: async () =>
    unwrap(
      await db.from("proposals").select("id, body, reason, spec, title").eq("status", "queued").order("id").limit(1).maybeSingle(),
    ) as Proposal | null,
  needsIdeas: async () => {
    const { min_ideas } = unwrap(await db.from("settings").select("min_ideas").single());
    const ideas = unwrap(await db.from("ideas").select("id").in("status", ["open", "pending_review"]).eq("is_no_change", false));
    return ideas.length < min_ideas;
  },
  markIdeasAsked: async () => {
    unwrap(await db.from("settings").update({ last_ai_ideas_at: new Date().toISOString() }).eq("id", true));
  },
  history: async () => {
    const changes = unwrap(await db.from("changes").select("kind, title").order("id", { ascending: false }).limit(20));
    const ideas = unwrap(await db.from("ideas").select("title").eq("status", "open").eq("is_no_change", false));
    return [...changes.map((c) => `${c.kind}: ${c.title}`), ...ideas.map((i) => `already on the idea board: ${i.title}`)].join("\n");
  },
  rejectProposal: async (id, reason) => {
    unwrap(await db.from("proposals").update({ status: "rejected", reason }).eq("id", id));
  },
  holdProposal: async (id, reason) => {
    unwrap(await db.from("proposals").update({ status: "held", reason }).eq("id", id));
  },
  queueProposal: async (id, spec) => {
    unwrap(await db.from("proposals").update({ status: "queued", title: spec.title, spec, reason: null }).eq("id", id));
  },
  addIdea: async ({ spec, source, proposalId, flagged }) => {
    unwrap(
      await db.rpc("add_idea", {
        p_title: spec.title,
        p_spec: spec,
        p_source: source,
        p_proposal: proposalId,
        p_flagged: flagged,
      }),
    );
  },
  reviewWaiting: async () => {
    const ideas = unwrap(await db.from("ideas").select("id").eq("status", "pending_review"));
    const held = unwrap(await db.from("proposals").select("id").eq("status", "held"));
    return ideas.length + held.length > 0;
  },
};

// Opening a GitHub issue emails the repo owner, so no mail service is needed.
async function notifyOwner(message: string): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY;
  const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" };
  const title = "Review needed";
  const open = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&labels=review`, { headers });
  if (((await open.json()) as unknown[]).length > 0) return;
  const created = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title,
      labels: ["review"],
      body: `${message}\n\nOpen https://${settings.hosts.vote}/review.html to approve or reject it, then close this issue.`,
    }),
  });
  if (!created.ok) console.error(`Couldn't open the review issue: ${created.status}`);
}

const RETRY_AFTER_FAILURE_MS = 6 * 3_600_000;

try {
  await runPlan({ ai: createAI(), store, game: describeGame(readGame("game")), notifyOwner });
} catch (error) {
  // A future timestamp makes the timer's throttle wait, so a broken run can't
  // keep spending API credit. The repo is public, so the issue stays generic.
  const retryAt = new Date(Date.now() + RETRY_AFTER_FAILURE_MS).toISOString();
  await db.from("settings").update({ last_plan_dispatch_at: retryAt }).eq("id", true);
  await notifyOwner("Planning failed and will retry in 6 hours. Check the latest Plan workflow run.");
  throw error;
}
