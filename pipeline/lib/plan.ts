import { NoAnswer, type AI, type ScreenResult } from "./ai.ts";
import { precheck, validateSpec, type Spec } from "./safety.ts";

export type Proposal = { id: number; body: string; reason: string | null; spec: Spec | null; title: string | null };

export interface Store {
  paused(): Promise<boolean>;
  pendingProposals(): Promise<Proposal[]>;
  nextQueued(): Promise<Proposal | null>;
  hasActiveBallot(): Promise<boolean>;
  history(): Promise<string>;
  rejectProposal(id: number, reason: string): Promise<void>;
  holdProposal(id: number, reason: string): Promise<void>;
  queueProposal(id: number, spec: Spec): Promise<void>;
  createBallot(input: {
    question: string;
    source: "ai" | "proposal";
    proposalId: number | null;
    options: Spec[];
    flagged: boolean;
  }): Promise<void>;
  reviewWaiting(): Promise<boolean>;
}

export type PlanDeps = {
  ai: AI;
  store: Store;
  game: string;
  notifyOwner: (message: string) => Promise<void>;
};

async function screen(ai: AI, body: string): Promise<ScreenResult | null> {
  try {
    return await ai.screen(body);
  } catch (error) {
    if (error instanceof NoAnswer) return null;
    throw error;
  }
}

async function screenPending({ ai, store }: PlanDeps): Promise<boolean> {
  let held = false;
  const hold = async (id: number, reason: string) => {
    held = true;
    await store.holdProposal(id, reason);
  };

  for (const proposal of await store.pendingProposals()) {
    const basic = precheck(proposal.body);
    if (!basic.ok) {
      await store.rejectProposal(proposal.id, basic.reason);
      continue;
    }
    const ownerApproved = proposal.reason === "owner_approved";
    const result = await screen(ai, proposal.body);
    if (!result) {
      await store.rejectProposal(proposal.id, "This proposal could not be accepted under the rules.");
      continue;
    }
    if (result.verdict === "reject") {
      await store.rejectProposal(proposal.id, result.public_reason);
      continue;
    }
    if (result.verdict === "unsure" && !ownerApproved) {
      await hold(proposal.id, result.public_reason);
      continue;
    }
    const specCheck = validateSpec(result.spec);
    if (!specCheck.ok) {
      // An owner's approval never overrides the spec format, because the
      // builder must only ever receive a clean spec.
      if (ownerApproved) await store.rejectProposal(proposal.id, specCheck.reason);
      else await hold(proposal.id, specCheck.reason);
      continue;
    }
    await store.queueProposal(proposal.id, result.spec);
  }
  return held;
}

async function ballotFromProposal({ ai, store, game }: PlanDeps, proposal: Proposal): Promise<void> {
  const spec = proposal.spec!;
  let verdict;
  try {
    verdict = await ai.review(spec, game);
  } catch (error) {
    if (!(error instanceof NoAnswer)) throw error;
    await store.rejectProposal(proposal.id, "This proposal could not be accepted under the rules.");
    return;
  }
  if (verdict.verdict === "reject") {
    await store.rejectProposal(proposal.id, verdict.public_reason);
    return;
  }
  await store.createBallot({
    question: `Should we make this change: ${spec.title}?`,
    source: "proposal",
    proposalId: proposal.id,
    options: [spec],
    flagged: verdict.verdict === "unsure",
  });
}

async function ballotFromQuestion({ ai, store, game }: PlanDeps): Promise<void> {
  const { question, options } = await ai.question(game, await store.history());
  const kept: Spec[] = [];
  let flagged = false;
  for (const option of options.slice(0, 4)) {
    if (!validateSpec(option).ok) continue;
    let verdict;
    try {
      verdict = await ai.review(option, game);
    } catch (error) {
      if (error instanceof NoAnswer) continue;
      throw error;
    }
    if (verdict.verdict === "reject") continue;
    if (verdict.verdict === "unsure") flagged = true;
    kept.push(option);
  }
  if (kept.length === 0) throw new NoAnswer("No question options passed review.");
  await store.createBallot({ question, source: "ai", proposalId: null, options: kept, flagged });
}

/** Screens new proposals, then fills the ballot slot if it's free. */
export async function runPlan(deps: PlanDeps): Promise<void> {
  const { store, notifyOwner } = deps;
  if (await store.paused()) return;

  const held = await screenPending(deps);

  if (!(await store.hasActiveBallot())) {
    let next = await store.nextQueued();
    while (next && !(await store.hasActiveBallot())) {
      await ballotFromProposal(deps, next);
      next = await store.nextQueued();
    }
    if (!(await store.hasActiveBallot())) await ballotFromQuestion(deps);
  }

  if (held || (await store.reviewWaiting())) {
    await notifyOwner("Something is waiting for your review.");
  }
}
