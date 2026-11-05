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
    board: async () => must(await db.rpc("board")),
    round: async () => must(await db.from("settings").select("round_number, round_closes_at, last_round_result").single()),
    async windowMinutes() {
      const [hours, minutes] = must(await db.rpc("cycle_interval")).split(":").map(Number);
      return hours * 60 + minutes;
    },
    async building() {
      const ballot = must(await db.from("ballots").select("winner_option_id").eq("status", "building").maybeSingle());
      if (!ballot) return null;
      return must(await db.from("options").select("label").eq("id", ballot.winner_option_id).single());
    },
    upvote: async (idea) => must(await db.rpc("toggle_upvote", { p_idea: idea })),
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
      const ideas = must(await db.from("ideas").select("*").eq("status", "pending_review"));
      const proposals = must(await db.from("proposals").select("*").eq("status", "held"));
      return { ideas, proposals };
    },
    reviewIdea: async (id, approve, reason) => must(await db.rpc("review_idea", { p_idea: id, p_approve: approve, p_reason: reason })),
    reviewProposal: async (id, approve, reason) => must(await db.rpc("review_proposal", { p_proposal: id, p_approve: approve, p_reason: reason })),
    setPaused: async (paused, reason) => must(await db.rpc("set_paused", { p_paused: paused, p_reason: reason })),
    clearName: async (name) => must(await db.rpc("clear_display_name", { p_name: name })),
  };
}

/** Sample data for local previews, used only when no Supabase project is configured. */
export function previewApi() {
  const spec = (summary) => ({ summary, changes: [], player_impact: "" });
  const closes = new Date(Date.now() + 22 * 60_000).toISOString();
  const ideas = [
    { id: 1, title: "A tiny tower climber", summary: "Tap to jump between platforms and climb as high as you can.", credit: "the AI", votes: 3, is_no_change: false, mine: false },
    { id: 2, title: "A garden that grows while you tend it", summary: "Plant seeds, water them, and fill the plot.", credit: "dragon_fan", votes: 1, is_no_change: false, mine: false },
    { id: 3, title: "A one-room mystery", summary: "Search a small room for clues to open the door.", credit: "the AI", votes: 2, is_no_change: false, mine: false },
    { id: 4, title: "Change nothing this round", summary: null, credit: "the rules", votes: 0, is_no_change: true, mine: false },
  ];
  let voted = false;
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
    board: async () => [...ideas].sort((a, b) => a.is_no_change - b.is_no_change || b.votes - a.votes),
    round: async () => ({ round_number: 4, round_closes_at: closes, last_round_result: 'Round 3: "A pet follows you" won.' }),
    windowMinutes: async () => 1,
    // Add ?building to the address to preview the banner, or ?building=once to see it finish.
    async building() {
      const value = new URLSearchParams(location.search).get("building");
      if (value === null || buildChecks++ > 0 && value === "once") return null;
      return { label: "A tiny tower climber" };
    },
    upvote: async (id) => {
      const idea = ideas.find((i) => i.id === id);
      idea.mine = !idea.mine;
      idea.votes += idea.mine ? 1 : -1;
      voted = true;
    },
    propose: async () => {},
    myName: async () => name,
    myProgress: async () => ({ votes: voted ? 6 : 5, streak: voted ? 6 : 5, on_ballot: 1, built: 0, points: voted ? 11 : 10 }),
    leaderboard: async () => [
      { name: "Dragon Fan", points: 46 },
      { name: "Moss", points: 12 },
    ],
    exportData: async () => ({ player_id: "preview", username: "preview", public_name: name || null, suggestions: [], votes: [] }),
    deleteAccount: async () => {
      leave();
      voted = false;
    },
    proposals: async () => [
      { id: 3, title: null, status: "pending", reason: null, credit: null, created_at: when(0.1) },
      { id: 2, title: "Add a pet that follows you", status: "on_ballot", reason: null, credit: "dragon_fan", created_at: when(1) },
      { id: 1, title: null, status: "rejected", reason: "Rule 9: the game can't collect personal information.", credit: null, created_at: when(3) },
    ],
    changes: async () => [
      { id: 3, kind: "vote", version: "v2", credit: "Dragon Fan", title: "A pet follows you", notes: "A small companion now trails the player.", created_at: when(2) },
      { id: 2, kind: "failed", version: null, credit: "a player", title: "Weather effects", notes: "The change failed its automated checks after one repair attempt, so it was dropped and the previous version stayed live.", created_at: when(5) },
      { id: 1, kind: "vote", version: "v1", credit: "the AI", title: "The first climb", notes: "The game begins with one tower and one jump.", created_at: when(9) },
    ],
    reviewQueue: async () => ({
      ideas: [{ id: 9, title: "Add a pet", credit: "Dragon Fan", spec: spec("A small pet follows you.") }],
      proposals: [{ id: 7, body: "Make a screen where players enter their birthday", reason: "Rule 9 may apply." }],
    }),
    reviewIdea: async () => {},
    reviewProposal: async () => {},
    setPaused: async () => {},
    clearName: async () => {},
  };
}
