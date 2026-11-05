// Attacks the live site the way a logged-out stranger could, using only public
// values. Every probe is harmless if it unexpectedly works: writes target rows
// that don't exist, or use values the database refuses.
import settings from "../config/settings.json" with { type: "json" };
import { verifyLive, type Check } from "./verify-live.ts";

const URL_BASE = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_ANON_KEY!;
const headers = { apikey: KEY, "Content-Type": "application/json" };
const NOBODY = "00000000-0000-0000-0000-000000000000";

const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  return { status: response.status, text: await response.text() };
}

// Tables a stranger must never read. An empty list also passes: row security hides the rows.
for (const table of ["proposals", "votes", "upvotes", "participation", "profiles", "owners", "ai_spend", "ideas", "schema_migrations"]) {
  const { status, text } = await rest(`${table}?select=*&limit=1`);
  add(`Can't read ${table}`, status >= 400 || text.trim() === "[]", `status ${status}`);
}

// The public view must never carry a suggestion's text or its author's ID.
const listed = await rest("public_proposals?select=*&limit=50");
add("Public suggestions hide text and authors", !/"(body|user_id|spec)"/.test(listed.text), `status ${listed.status}`);

const settingsRow = await rest("settings?select=*");
add("Settings hold nothing secret", !/token|secret|password|sk-ant/i.test(settingsRow.text), `status ${settingsRow.status}`);

// Direct writes, aimed at rows that don't exist.
for (const [method, path, body] of [
  ["PATCH", "settings?id=is.false", { paused: true }],
  ["PATCH", "ideas?id=eq.-1", { status: "won" }],
  ["PATCH", "ballots?id=eq.-1", { status: "closed" }],
  ["DELETE", "changes?id=eq.-1", undefined],
  ["POST", "owners", { user_id: NOBODY }],
  ["POST", "upvotes", { idea_id: -1, user_id: NOBODY }],
  ["POST", "changes", { kind: "bad", title: "x" }],
] as const) {
  const { status, text } = await rest(path, { method, body: body ? JSON.stringify(body) : undefined });
  add(`Can't ${method} ${path.split("?")[0]}`, status === 401 || status === 403, `status ${status} ${text.slice(0, 60)}`);
}

// Functions a stranger must not be able to call.
for (const [name, args] of [
  ["tick", {}],
  ["scheduled_tick", {}],
  ["purge_old_data", {}],
  ["complete_build", { p_ballot: -1, p_ok: false, p_version: "x", p_title: "x", p_notes: "x" }],
  ["add_idea", { p_title: "x", p_spec: {}, p_source: "bad", p_proposal: null, p_flagged: false, p_size: "bad" }],
  ["erase_player", { p_user: NOBODY }],
  ["scrub_credit", { p_user: NOBODY }],
  ["player_stats", { p_user: NOBODY }],
  ["active_players", {}],
  ["vote_tally", {}],
  ["required_votes", { p_size: "small" }],
  ["set_paused", { p_paused: false, p_reason: "security check" }],
  ["set_idea_size", { p_idea: -1, p_size: "bad" }],
  ["set_ai_credit", { p_dollars: -1 }],
  ["spending_summary", {}],
  ["review_idea", { p_idea: -1, p_approve: false, p_reason: "x" }],
  ["review_proposal", { p_proposal: -1, p_approve: false, p_reason: "x" }],
  ["clear_display_name", { p_name: "nobody-here" }],
  ["set_display_name", { p_name: "x" }],
  ["remove_my_name", {}],
  ["delete_my_account", {}],
  ["export_my_data", {}],
  ["my_progress", {}],
  ["toggle_upvote", { p_idea: -1 }],
  ["submit_proposal", { p_body: "x" }],
  ["cast_vote", { p_ballot: -1, p_option: -1 }],
] as const) {
  const { status, text } = await rest(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  const denied = status >= 400 && !/"code":"(22|23)/.test(text);
  add(`Can't call ${name}`, denied, `status ${status} ${text.slice(0, 70)}`);
}

// Accounts must never hold a real address, and anonymous sign-in must stay off.
const signup = await fetch(`${URL_BASE}/auth/v1/signup`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email: "security-check@example.org", password: "Probe-only-9f3k2-x" }),
});
add("Real email addresses are refused", signup.status >= 400, `status ${signup.status}`);
const auth = (await (await fetch(`${URL_BASE}/auth/v1/settings`, { headers })).json()) as {
  external: { anonymous_users: boolean };
  mailer_autoconfirm: boolean;
};
add("Anonymous sign-ins are off", !auth.external.anonymous_users, String(auth.external.anonymous_users));
add("Confirm email is off, so no email is sent", auth.mailer_autoconfirm, String(auth.mailer_autoconfirm));

// Files that must not be public.
for (const host of [settings.hosts.vote, settings.hosts.game]) {
  for (const path of [".env", ".git/config", ".htaccess", "package.json", "pipeline/deploy.ts"]) {
    const response = await fetch(`https://${host}/${path}`, { redirect: "manual" });
    add(`${host}/${path} isn't public`, response.status !== 200, `status ${response.status}`);
  }
}

// The game frame must keep its limits, and the voting site must keep its own.
const vote = await fetch(`https://${settings.hosts.vote}/`);
const policy = vote.headers.get("content-security-policy") ?? "";
add("Voting site allows no inline scripts", !policy.includes("unsafe") && policy.includes("script-src 'self'"), policy.slice(0, 60));
const page = await vote.text();
add("Voting page holds no service key", !/service_role|sb_secret_[A-Za-z0-9]/.test(page), "checked");
const script = page.match(/app\.js\?v=[a-f0-9]+/)?.[0];
const bundle = script ? await (await fetch(`https://${settings.hosts.vote}/${script}`)).text() : "";
add("Site script holds no secret", bundle.length > 0 && !/sb_secret_[A-Za-z0-9]|sk-ant-|service_role/.test(bundle), `${bundle.length} bytes`);

checks.push(...(await verifyLive()));

for (const c of checks) if (!c.ok || process.env.VERBOSE) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name} (${c.detail})`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed} of ${checks.length} security checks passed.`);
process.exitCode = failed ? 1 : 0;
