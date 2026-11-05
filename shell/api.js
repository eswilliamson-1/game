import { createClient } from "@supabase/supabase-js";

const must = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

// Supabase Auth needs an email field. Nothing is ever sent to this address, and
// the database refuses any other domain, so real addresses can't be stored.
const ACCOUNT_DOMAIN = "players.ewpages.com";
const accountEmail = (username) => `${username.toLowerCase()}@${ACCOUNT_DOMAIN}`;

export function liveApi(url, key) {
  const db = createClient(url, key);
  return {
    preview: false,
    async user() {
      const { data } = await db.auth.getSession();
      return data.session?.user ?? null;
    },
    async signUp(username, password) {
      const { data, error } = await db.auth.signUp({ email: accountEmail(username), password });
      if (error) {
        if (/already/i.test(error.message)) throw new Error("That username is taken.");
        if (/database error/i.test(error.message)) throw new Error("That username isn't allowed.");
        throw new Error(error.message);
      }
      if (!data.session) throw new Error("Accounts aren't set up correctly yet. Please try again later.");
    },
    async signIn(username, password) {
      const { error } = await db.auth.signInWithPassword({ email: accountEmail(username), password });
      if (error) throw new Error(/invalid/i.test(error.message) ? "Wrong username or password." : error.message);
    },
    signOut: () => db.auth.signOut({ scope: "local" }),
    onAuthChange: (fn) => db.auth.onAuthStateChange(() => fn()),
    isOwner: async () => must(await db.rpc("is_owner")),
    paused: async () => must(await db.from("settings").select("paused").single()).paused,
    async currentBallot() {
      const ballot = must(
        await db.from("ballots").select("*").in("status", ["open", "building"]).order("id", { ascending: false }).limit(1).maybeSingle(),
      );
      if (!ballot) return null;
      const options = must(await db.from("options").select("*").eq("ballot_id", ballot.id).order("id"));
      const results = must(await db.rpc("ballot_results", { p_ballot: ballot.id }));
      return { ...ballot, options, results };
    },
    async windowMinutes() {
      const [hours, minutes] = must(await db.rpc("cycle_interval")).split(":").map(Number);
      return hours * 60 + minutes;
    },
    async building() {
      const ballot = must(await db.from("ballots").select("winner_option_id").eq("status", "building").maybeSingle());
      if (!ballot) return null;
      return must(await db.from("options").select("label").eq("id", ballot.winner_option_id).single());
    },
    async myVote(ballotId, userId) {
      const row = must(await db.from("votes").select("option_id").eq("ballot_id", ballotId).eq("user_id", userId).maybeSingle());
      return row?.option_id ?? null;
    },
    vote: async (ballot, option) => must(await db.rpc("cast_vote", { p_ballot: ballot, p_option: option })),
    propose: async (body) => must(await db.rpc("submit_proposal", { p_body: body })),
    myName: async (userId) => must(await db.from("profiles").select("display_name").eq("user_id", userId).maybeSingle())?.display_name ?? "",
    myProgress: async () => must(await db.rpc("my_progress")),
    leaderboard: async () => must(await db.rpc("leaderboard")),
    exportData: async () => must(await db.rpc("export_my_data")),
    async deleteAccount() {
      must(await db.rpc("delete_my_account"));
      await db.auth.signOut({ scope: "local" });
    },
    proposals: async (limit) => must(await db.from("public_proposals").select("*").order("id", { ascending: false }).limit(limit)),
    changes: async () => must(await db.from("changes").select("*").order("id", { ascending: false }).limit(200)),
    async reviewQueue() {
      const ballots = must(await db.from("ballots").select("*, options(*)").eq("status", "pending_review"));
      const proposals = must(await db.from("proposals").select("*").eq("status", "held"));
      return { ballots, proposals };
    },
    reviewBallot: async (id, approve, reason) => must(await db.rpc("review_ballot", { p_ballot: id, p_approve: approve, p_reason: reason })),
    reviewProposal: async (id, approve, reason) => must(await db.rpc("review_proposal", { p_proposal: id, p_approve: approve, p_reason: reason })),
    setPaused: async (paused, reason) => must(await db.rpc("set_paused", { p_paused: paused, p_reason: reason })),
    clearName: async (name) => must(await db.rpc("clear_display_name", { p_name: name })),
  };
}

/** Sample data for local previews, used only when no Supabase project is configured. */
export function previewApi() {
  const spec = (summary) => ({ summary, changes: [], player_impact: "" });
  const ballot = {
    id: 1,
    status: "open",
    question: "What kind of game should this become?",
    credit: "the AI",
    closes_at: new Date(Date.now() + 22 * 60_000).toISOString(),
    options: [
      { id: 1, label: "A tiny tower climber", spec: spec("Tap to jump between platforms and climb as high as you can."), is_no_change: false },
      { id: 2, label: "A garden that grows while you tend it", spec: spec("Plant seeds, water them, and fill the plot."), is_no_change: false },
      { id: 3, label: "A one-room mystery", spec: spec("Search a small room for clues to open the door."), is_no_change: false },
      { id: 4, label: "Do not do this change", spec: null, is_no_change: true },
    ],
    results: [
      { option_id: 1, votes: 3 },
      { option_id: 2, votes: 1 },
      { option_id: 3, votes: 2 },
      { option_id: 4, votes: 0 },
    ],
  };
  let vote = null;
  let buildChecks = 0;
  // Kept for the tab, so the preview stays joined between pages.
  let name = sessionStorage.getItem("preview-name") ?? "";
  let signedIn = Boolean(name);
  const join = (username) => {
    signedIn = true;
    name = username.toLowerCase();
    sessionStorage.setItem("preview-name", name);
  };
  const leave = () => {
    signedIn = false;
    name = "";
    sessionStorage.removeItem("preview-name");
  };
  const when = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  return {
    preview: true,
    user: async () => (signedIn ? { id: "preview" } : null),
    signUp: async (username) => join(username),
    signIn: async (username) => join(username),
    signOut: async () => leave(),
    onAuthChange: () => {},
    isOwner: async () => signedIn,
    paused: async () => false,
    currentBallot: async () => ballot,
    windowMinutes: async () => 1,
    // Add ?building to the address to preview the banner, or ?building=once to see it finish.
    async building() {
      const value = new URLSearchParams(location.search).get("building");
      if (value === null || buildChecks++ > 0 && value === "once") return null;
      return { label: "A tiny tower climber" };
    },
    myVote: async () => vote,
    vote: async (_, option) => {
      if (vote) ballot.results.find((r) => r.option_id === vote).votes--;
      vote = option;
      ballot.results.find((r) => r.option_id === option).votes++;
    },
    propose: async () => {},
    myName: async () => name,
    myProgress: async () => ({ votes: vote ? 6 : 5, streak: vote ? 6 : 5, on_ballot: 1, built: 0, points: vote ? 11 : 10 }),
    leaderboard: async () => [
      { name: "Dragon Fan", points: 46 },
      { name: "Moss", points: 12 },
    ],
    exportData: async () => ({ player_id: "preview", username: "preview", public_name: name || null, suggestions: [], votes: [] }),
    deleteAccount: async () => {
      leave();
      vote = null;
    },
    proposals: async () => [
      { id: 3, title: null, status: "pending", reason: null, credit: null, created_at: when(0.1) },
      { id: 2, title: "Add a pet that follows you", status: "queued", reason: null, credit: "dragon_fan", created_at: when(1) },
      { id: 1, title: null, status: "rejected", reason: "Rule 9: the game can't collect personal information.", credit: null, created_at: when(3) },
    ],
    changes: async () => [
      { id: 3, kind: "vote", version: "v2", credit: "Dragon Fan", title: "A pet follows you", notes: "A small companion now trails the player.", created_at: when(2) },
      { id: 2, kind: "failed", version: null, credit: "a player", title: "Weather effects", notes: "The change failed its automated checks after one repair attempt, so it was dropped and the previous version stayed live.", created_at: when(5) },
      { id: 1, kind: "vote", version: "v1", credit: "the AI", title: "The first climb", notes: "The game begins with one tower and one jump.", created_at: when(9) },
    ],
    reviewQueue: async () => ({
      ballots: [{ id: 9, question: "Should we make this change: Add a pet?", credit: "Dragon Fan", options: ballot.options.slice(0, 2) }],
      proposals: [{ id: 7, body: "Make a screen where players enter their birthday", reason: "Rule 9 may apply." }],
    }),
    reviewBallot: async () => {},
    reviewProposal: async () => {},
    setPaused: async () => {},
    clearName: async () => {},
  };
}
