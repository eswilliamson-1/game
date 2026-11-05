import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const OWNER = "00000000-0000-0000-0000-000000000001";
const ALICE = "00000000-0000-0000-0000-000000000002";
const BOB = "00000000-0000-0000-0000-000000000003";

let db: PGlite;
let moved: string[] = [];

// Stands in for the parts of Supabase the migration relies on.
const SUPABASE_STUB = `
  create role anon; create role authenticated; create role service_role bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key, email text, created_at timestamptz not null default now(), last_sign_in_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  insert into auth.users values ('${OWNER}'), ('${ALICE}'), ('${BOB}');
`;

async function as(role: string, uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`set test.uid = '${uid}'; set role ${role};`);
  try {
    return await db.query<Record<string, any>>(sql, params);
  } finally {
    await db.exec(`reset role; set test.uid = '';`);
  }
}
const service = (sql: string, params: unknown[] = []) => as("service_role", "", sql, params);
const user = (uid: string, sql: string, params: unknown[] = []) => as("authenticated", uid, sql, params);
const setName = (uid: string, name: string) =>
  db.query(
    `insert into profiles (user_id, display_name) values ($1, $2)
     on conflict (user_id) do update set display_name = excluded.display_name`,
    [uid, name],
  );

async function reset() {
  await db.exec(`
    truncate votes, options, ballots, proposals, changes, profiles, participation restart identity cascade;
    insert into ideas (title, source, credit, status, is_no_change)
      values ('Change nothing this round', 'rules', 'the rules', 'open', true);
    update settings set paused = false, launch_review = false, last_plan_dispatch_at = null,
      round_number = 1, round_closes_at = null, last_round_result = null, last_ai_ideas_at = null;
  `);
}

async function addIdea(title = "Add a dragon", flagged = false, proposal: number | null = null) {
  const source = proposal ? "proposal" : "ai";
  const { rows } = await service(`select add_idea($1, $2::jsonb, $3, $4, $5) as id`, [title, JSON.stringify({ title }), source, proposal, flagged]);
  return rows[0].id as number;
}

const up = (uid: string, idea: number) => user(uid, `select toggle_upvote($1)`, [idea]);
const noChange = async () => (await db.query<{ id: number }>(`select id from ideas where is_no_change`)).rows[0].id;
const round = async () => (await db.query<Record<string, any>>(`select * from settings`)).rows[0];
const idea = async (id: number) => (await db.query<Record<string, any>>(`select * from ideas where id = $1`, [id])).rows[0];
const ballot = async (id: number) => (await db.query<Record<string, any>>(`select * from ballots where id = $1`, [id])).rows[0];

async function endRound() {
  await db.exec(`update settings set round_closes_at = now() - interval '1 minute'`);
  return (await service(`select tick() as r`)).rows[0].r;
}

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(readFileSync("supabase/migrations/0001_init.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0003_accounts_privacy.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0005_username_accounts.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0006_login_names.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0007_public_record_timer.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0008_one_minute_pace.sql", "utf8"));
  await db.query(`insert into owners values ($1)`, [OWNER]);
  await db.query(`select create_ballot('Old question', 'ai', null, '[{"label":"Old idea"}]', false)`);
  await db.exec(readFileSync("supabase/migrations/0009_idea_board.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0010_build_stage.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0011_fresh_ai_ideas.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0012_idea_sizes.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0013_safe_updates.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0014_timer_and_spending.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0015_medium_needs_one.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0016_major_scales_down.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0017_active_means_three_days.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0018_major_needs_a_third.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0019_more_daily_suggestions.sql", "utf8"));
  moved = (await db.query<{ title: string }>(`select title from ideas where not is_no_change`)).rows.map((r) => r.title);
});

test("ideas on a live ballot move to the board", () => {
  assert.deepEqual(moved, ["Old idea"]);
});

test("the board always has 'change nothing this round', and only once", async () => {
  await reset();
  const { rows } = await as("anon", "", `select * from board()`);
  assert.deepEqual(rows.map((r) => [r.title, r.is_no_change]), [["Change nothing this round", true]]);
  await assert.rejects(db.exec(`insert into ideas (title, source, status, is_no_change) values ('x', 'rules', 'open', true)`));
});

test("no votes means no clock and nothing moves", async () => {
  await reset();
  await addIdea();
  assert.deepEqual((await service(`select tick() as r`)).rows[0].r.build, []);
  const s = await round();
  assert.equal(s.round_closes_at, null);
  assert.equal(s.round_number, 1);
});

test("one upvote starts the clock and is enough to win", async () => {
  await reset();
  const id = await addIdea();
  await up(ALICE, id);
  assert.ok((await round()).round_closes_at);
  assert.deepEqual((await service(`select tick() as r`)).rows[0].r.build, []);
  const { build } = await endRound();
  assert.equal(build.length, 1);
  const made = await ballot(build[0]);
  assert.equal(made.status, "building");
  assert.equal(made.question, "Add a dragon");
  assert.equal((await idea(id)).status, "won");
  const s = await round();
  assert.equal(s.round_number, 2);
  assert.equal(s.round_closes_at, null);
});

test("a build starts at the writing stage, and anyone can see how far along it is", async () => {
  await reset();
  await up(ALICE, await addIdea());
  const { build } = await endRound();
  const read = () => as("anon", "", `select build_stage from ballots where id = $1`, [build[0]]);
  assert.equal((await read()).rows[0].build_stage, "writing");
  await service(`update ballots set build_stage = 'testing' where id = $1`, [build[0]]);
  assert.equal((await read()).rows[0].build_stage, "testing");
  await assert.rejects(service(`update ballots set build_stage = 'anything' where id = $1`, [build[0]]));
});

test("a release clears old AI ideas and asks for new ones, but keeps player ideas", async () => {
  await reset();
  const { rows } = await user(BOB, `select submit_proposal('Add a pet dragon') as id`);
  const [winner, stale, mine] = [await addIdea("Winner"), await addIdea("Old AI idea"), await addIdea("Player idea", false, rows[0].id)];
  await db.exec(`update settings set last_ai_ideas_at = now()`);
  await up(ALICE, winner);
  const { build } = await endRound();
  await service(`select complete_build($1, true, 'v1', 'Winner', 'Done')`, [build[0]]);
  assert.equal((await idea(stale)).status, "rejected");
  assert.equal((await idea(mine)).status, "open");
  assert.equal((await round()).last_ai_ideas_at, null);
});

test("a failed build keeps the AI ideas", async () => {
  await reset();
  const [winner, other] = [await addIdea("Winner"), await addIdea("Other")];
  await up(ALICE, winner);
  const { build } = await endRound();
  await service(`select complete_build($1, false, null, 'Winner', 'Failed')`, [build[0]]);
  assert.equal((await idea(other)).status, "open");
});

test("the top idea wins, and other votes carry into the next round", async () => {
  await reset();
  const [a, b] = [await addIdea("A"), await addIdea("B")];
  await up(ALICE, a);
  await up(BOB, a);
  await up(OWNER, b);
  const { build } = await endRound();
  assert.equal((await ballot(build[0])).question, "A");
  const board = await as("anon", "", `select title, votes::int from board() where not building`);
  assert.deepEqual(board.rows, [{ title: "B", votes: 1 }, { title: "Change nothing this round", votes: 0 }]);
});

test("ties change nothing, and the tied ideas keep their votes", async () => {
  await reset();
  const [a, b] = [await addIdea("A"), await addIdea("B")];
  await up(ALICE, a);
  await up(BOB, b);
  assert.deepEqual((await endRound()).build, []);
  const s = await round();
  assert.match(s.last_round_result, /tie/);
  assert.equal(s.round_number, 2);
  assert.equal((await idea(a)).status, "open");
  const { rows } = await db.query<{ n: number }>(`select count(*)::int n from upvotes`);
  assert.equal(rows[0].n, 2);
});

test("'change nothing' can win, and its votes reset each round", async () => {
  await reset();
  await addIdea();
  const nothing = await noChange();
  await up(ALICE, nothing);
  assert.deepEqual((await endRound()).build, []);
  assert.match((await round()).last_round_result, /change nothing/);
  assert.equal((await db.query(`select 1 from upvotes`)).rows.length, 0);
});

test("a tie with 'change nothing' changes nothing", async () => {
  await reset();
  const id = await addIdea();
  await up(ALICE, id);
  await up(BOB, await noChange());
  assert.deepEqual((await endRound()).build, []);
  assert.equal((await idea(id)).status, "open");
});

test("upvoting twice takes the vote back, and players can back several ideas", async () => {
  await reset();
  const [a, b] = [await addIdea("A"), await addIdea("B")];
  await up(ALICE, a);
  await up(ALICE, b);
  await up(ALICE, a);
  const { rows } = await user(ALICE, `select title, mine from board() where not is_no_change order by title`);
  assert.deepEqual(rows, [{ title: "A", mine: false }, { title: "B", mine: true }]);
});

test("if everyone takes their votes back, the round doesn't end", async () => {
  await reset();
  const id = await addIdea();
  await up(ALICE, id);
  await up(ALICE, id);
  assert.deepEqual((await endRound()).build, []);
  const s = await round();
  assert.equal(s.round_closes_at, null);
  assert.equal(s.round_number, 1);
});

test("a round can't end while a change is building", async () => {
  await reset();
  const [a, b] = [await addIdea("A"), await addIdea("B")];
  await up(ALICE, a);
  const { build } = await endRound();
  await up(BOB, b);
  await endRound();
  assert.equal((await idea(b)).status, "open");
  await service(`select complete_build($1, true, 'v1', 'A', 'Done')`, [build[0]]);
  const next = (await service(`select tick() as r`)).rows[0].r;
  assert.equal(next.build.length, 1);
  assert.equal((await idea(b)).status, "won");
});

test("upvoting needs a login and an idea on the board", async () => {
  await reset();
  const id = await addIdea();
  await assert.rejects(as("anon", "", `select toggle_upvote($1)`, [id]));
  await assert.rejects(up(ALICE, 999999));
  await up(ALICE, id);
  await endRound();
  await assert.rejects(up(BOB, id));
});

test("players can't write to tables directly or run pipeline functions", async () => {
  await reset();
  const id = await addIdea();
  await assert.rejects(user(ALICE, `insert into upvotes (idea_id, user_id) values ($1, $2)`, [id, ALICE]));
  await assert.rejects(user(ALICE, `update ideas set status = 'won'`));
  await assert.rejects(user(ALICE, `update settings set paused = true`));
  await assert.rejects(user(ALICE, `update ballots set status = 'closed'`));
  await assert.rejects(user(ALICE, `select tick()`));
  await assert.rejects(user(ALICE, `select complete_build(1, true, 'v1', 'x', 'y')`));
  await assert.rejects(user(ALICE, `select add_idea('x', '{}', 'ai', null, false)`));
  await assert.rejects(user(ALICE, `select cast_vote(1, 1)`));
});

test("players can't see who voted for what, or anyone's proposal text", async () => {
  await reset();
  const id = await addIdea();
  await up(ALICE, id);
  await user(ALICE, `select submit_proposal('Add a pet dragon')`);
  await assert.rejects(user(BOB, `select * from upvotes`));
  await assert.rejects(user(BOB, `select * from participation`));
  assert.equal((await user(BOB, `select * from proposals`)).rows.length, 0);
  assert.equal((await user(ALICE, `select * from proposals`)).rows.length, 1);
  const { rows } = await user(BOB, `select votes::int, mine from board() where id = $1`, [id]);
  assert.deepEqual(rows, [{ votes: 1, mine: false }]);
});

test("proposals with links, code, or hidden characters are refused", async () => {
  await reset();
  for (const bad of [
    "visit https://evil.example now",
    "go to evil.com please",
    "<script>alert(1)</script>",
    "add ${process.env} here",
    "hidden​text",
    "x".repeat(281),
    "   ",
  ]) {
    await assert.rejects(user(ALICE, `select submit_proposal($1)`, [bad]), /./, bad);
  }
});

test("proposals are limited per person per day", async () => {
  await reset();
  for (let i = 0; i < 10; i++) await user(ALICE, `select submit_proposal($1)`, [`Idea ${i}`]);
  await assert.rejects(user(ALICE, `select submit_proposal('One more')`));
  await user(BOB, `select submit_proposal('A different player')`);
});

test("during launch review, ideas stay hidden until the owner approves", async () => {
  await reset();
  await db.exec(`update settings set launch_review = true`);
  const id = await addIdea();
  assert.equal((await idea(id)).status, "pending_review");
  assert.equal((await user(ALICE, `select * from board() where id = $1`, [id])).rows.length, 0);
  assert.equal((await user(ALICE, `select * from ideas`)).rows.length, 0);
  await assert.rejects(up(ALICE, id));
  await assert.rejects(user(ALICE, `select review_idea($1, true, '')`, [id]));
  await user(OWNER, `select review_idea($1, true, '')`, [id]);
  assert.equal((await idea(id)).status, "open");
});

test("a flagged idea needs review even after the launch period", async () => {
  await reset();
  assert.equal((await idea(await addIdea("x", true))).status, "pending_review");
});

test("rejecting an idea needs a public reason, which reaches the suggestion", async () => {
  await reset();
  const { rows } = await user(ALICE, `select submit_proposal('Add a dragon') as id`);
  const id = await addIdea("Add a dragon", true, rows[0].id);
  await assert.rejects(user(OWNER, `select review_idea($1, false, ' ')`, [id]));
  await user(OWNER, `select review_idea($1, false, 'Breaks rule 8')`, [id]);
  assert.equal((await idea(id)).status, "rejected");
  const listed = await as("anon", "", `select status, reason from public_proposals`);
  assert.deepEqual(listed.rows, [{ status: "rejected", reason: "Breaks rule 8" }]);
});

test("pausing stops the timer and voting, and is publicly logged", async () => {
  await reset();
  const id = await addIdea();
  await assert.rejects(user(ALICE, `select set_paused(true, 'x')`));
  await user(OWNER, `select set_paused(true, 'Security check')`);
  await assert.rejects(up(ALICE, id));
  const { rows } = await service(`select tick() as r`);
  assert.equal(rows[0].r.paused, true);
  const log = await as("anon", "", `select kind, notes from changes`);
  assert.deepEqual(log.rows, [{ kind: "pause", notes: "Security check" }]);
});

test("a failed build is published, and the next round can run", async () => {
  await reset();
  const [a, b] = [await addIdea("A"), await addIdea("B")];
  await up(ALICE, a);
  const { build } = await endRound();
  await service(`select complete_build($1, false, null, 'A', 'Failed the frame rate test')`, [build[0]]);
  assert.equal((await ballot(build[0])).status, "closed");
  const log = await as("anon", "", `select kind, notes from changes`);
  assert.deepEqual(log.rows, [{ kind: "failed", notes: "Failed the frame rate test" }]);
  await up(ALICE, b);
  assert.equal((await endRound()).build.length, 1);
});

test("planning runs for new suggestions or a low board, but can't repeat quickly", async () => {
  await reset();
  assert.equal((await service(`select tick() as r`)).rows[0].r.plan, true);
  assert.equal((await service(`select tick() as r`)).rows[0].r.plan, false);
  await db.exec(`update settings set last_plan_dispatch_at = null`);
  for (const title of ["A", "B", "C"]) await addIdea(title);
  assert.equal((await service(`select tick() as r`)).rows[0].r.plan, false);
});

test("a low board only asks the AI for ideas every so often", async () => {
  await reset();
  await db.exec(`update settings set last_ai_ideas_at = now()`);
  assert.equal((await service(`select tick() as r`)).rows[0].r.plan, false);
  await db.exec(`update settings set last_ai_ideas_at = now() - interval '31 minutes'`);
  assert.equal((await service(`select tick() as r`)).rows[0].r.plan, true);
});

test("the pace is fast for a few players and slows as more become active", async () => {
  await reset();
  const minutes = async () => {
    const { rows } = await service("select extract(epoch from cycle_interval()) / 60 as m");
    return Number(rows[0].m);
  };
  const addPlayers = async (from: number, to: number, age = "0 days") => {
    await db.query(
      `insert into auth.users (id) select ('10000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
       from generate_series($1::int, $2::int) n on conflict do nothing`,
      [from, to],
    );
    await db.query(
      `insert into proposals (user_id, body, status, created_at)
       select ('10000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'x', 'rejected', now() - $3::interval
       from generate_series($1::int, $2::int) n`,
      [from, to, age],
    );
  };
  await db.query(`update settings set max_total_proposals_per_day = 100000`);
  try {
    assert.equal(await minutes(), 1);
    await addPlayers(1, 5);
    assert.equal(await minutes(), 1);
    await addPlayers(6, 6);
    assert.equal(await minutes(), 30);
    await addPlayers(7, 26);
    assert.equal(await minutes(), 120);
    await addPlayers(27, 101);
    assert.equal(await minutes(), 360);

    await db.exec("truncate proposals restart identity cascade");
    await addPlayers(1, 200, "8 days");
    assert.equal(await minutes(), 1);
  } finally {
    await db.query(`update settings set max_total_proposals_per_day = 100`);
    await db.exec("truncate proposals restart identity cascade");
    await db.exec(`delete from auth.users where id::text like '10000000-%'`);
  }
});

async function buildProposal(uid: string) {
  const { rows } = await user(uid, "select submit_proposal('Add a pet dragon') as id");
  const id = await addIdea("Add it", false, rows[0].id);
  await up(ALICE, id);
  const { build } = await endRound();
  await service("select complete_build($1, true, 'v1', 'Pet dragon', 'Dragons now follow you')", [build[0]]);
}

test("patch notes credit the player who suggested the change", async () => {
  await reset();
  await setName(BOB, "Dragon Fan");
  await buildProposal(BOB);
  const log = await as("anon", "", "select credit, title from changes");
  assert.deepEqual(log.rows, [{ credit: "Dragon Fan", title: "Pet dragon" }]);
});

test("players with no name are credited as 'a player', and AI ideas as the AI", async () => {
  await reset();
  await buildProposal(BOB);
  assert.equal((await as("anon", "", "select credit from changes")).rows[0].credit, "a player");
  assert.equal((await idea(await addIdea())).credit, "the AI");
});

test("usernames become public names, can't be changed, and reserved ones are refused", async () => {
  await reset();
  const add = (email: string) => db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1)`, [email]);
  await add("dragon_fan@players.ewpages.com");
  const { rows } = await db.query<Record<string, any>>(`select display_name from profiles`);
  assert.deepEqual(rows, [{ display_name: "dragon_fan" }]);
  for (const bad of ["site_admin", "the-owner", "claude", "ewpages1"]) {
    await assert.rejects(add(`${bad}@players.ewpages.com`), /reserved/, bad);
  }
  await assert.rejects(user(ALICE, "select set_display_name('New Name')"));
  await assert.rejects(user(ALICE, "select remove_my_name()"));
  await assert.rejects(as("anon", "", "select * from profiles"));
  await db.query(`delete from auth.users where email = 'dragon_fan@players.ewpages.com'`);
});

test("the owner can remove an offensive name from the public history", async () => {
  await reset();
  await setName(BOB, "Rude Name");
  await buildProposal(BOB);
  await assert.rejects(user(ALICE, "select clear_display_name('Rude Name')"));
  await user(OWNER, "select clear_display_name('Rude Name')");
  assert.equal((await as("anon", "", "select credit from changes")).rows[0].credit, "a player");
});

const CAROL = "00000000-0000-0000-0000-000000000004";
const addCarol = () => db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [CAROL]);

test("deleting an account removes the player and every credit, including old names", async () => {
  await reset();
  await addCarol();
  await setName(CAROL, "Old Name");
  await buildProposal(CAROL);
  await setName(CAROL, "New Name");
  await user(CAROL, "select submit_proposal('A second idea')");
  await user(CAROL, "select delete_my_account()");

  assert.equal((await db.query(`select 1 from auth.users where id = $1`, [CAROL])).rows.length, 0);
  assert.equal((await db.query(`select 1 from profiles where user_id = $1`, [CAROL])).rows.length, 0);
  assert.equal((await as("anon", "", "select credit from changes")).rows[0].credit, "a player");
  const left = await db.query<Record<string, any>>(`select body, user_id from proposals`);
  assert.deepEqual(left.rows, [{ body: "[removed]", user_id: null }]);
});

test("the owner can't delete their account by accident, and logged-out visitors can't delete at all", async () => {
  await reset();
  await assert.rejects(user(OWNER, "select delete_my_account()"), /owner/);
  await assert.rejects(as("anon", "", "select delete_my_account()"));
});

test("players can't erase or inspect someone else", async () => {
  await reset();
  await assert.rejects(user(ALICE, `select erase_player('${BOB}')`));
  await assert.rejects(user(ALICE, `select player_stats('${BOB}')`));
  await assert.rejects(user(ALICE, "select purge_old_data()"));
});

test("a data export holds only that player's data", async () => {
  await reset();
  await user(ALICE, "select submit_proposal('Alice idea')");
  await user(BOB, "select submit_proposal('Bob idea')");
  const { rows } = await user(ALICE, "select export_my_data() as data");
  assert.deepEqual(rows[0].data.suggestions.map((s: any) => s.text), ["Alice idea"]);
  assert.equal(rows[0].data.player_id, ALICE);
});

test("proposals with contact details are refused", async () => {
  await reset();
  for (const bad of ["Message me at someone@mail.example", "Call +1 (555) 010-9999 for ideas", "My number is 555-010-9999"]) {
    await assert.rejects(user(ALICE, "select submit_proposal($1)", [bad]), /contact details/, bad);
  }
  await user(ALICE, "select submit_proposal('Add 3 dragons and 20 coins')");
});

test("a site-wide daily limit caps proposals across all accounts", async () => {
  await reset();
  await db.query(`update settings set max_total_proposals_per_day = 2`);
  try {
    await user(ALICE, "select submit_proposal('One')");
    await user(BOB, "select submit_proposal('Two')");
    await assert.rejects(user(OWNER, "select submit_proposal('Three')"), /daily suggestion limit/);
  } finally {
    await db.query(`update settings set max_total_proposals_per_day = 100`);
  }
});

test("the daily cleanup clears old text and stale accounts, but keeps owners and pending work", async () => {
  await reset();
  await addCarol();
  await db.query(`update auth.users set created_at = now() - interval '2 years'`);
  await user(ALICE, "select submit_proposal('Old rejected idea')");
  await user(BOB, "select submit_proposal('Old pending idea')");
  await db.query(`update proposals set created_at = now() - interval '40 days'`);
  await db.query(`update proposals set status = 'rejected' where user_id = $1`, [ALICE]);

  const { rows } = await service("select purge_old_data() as result");
  assert.equal(rows[0].result.proposals_cleared, 1);
  const bodies = await db.query<Record<string, any>>(`select body, status from proposals order by id`);
  assert.equal(bodies.rows.find((p) => p.status === "pending")?.body, "Old pending idea");

  const users = (await db.query<Record<string, any>>(`select id from auth.users`)).rows.map((u) => u.id);
  assert.ok(users.includes(OWNER));
  assert.ok(!users.includes(CAROL));

  await db.query(`insert into auth.users (id) values ($1), ($2) on conflict do nothing`, [ALICE, BOB]);
  await db.query(`update auth.users set created_at = now()`);
});

test("points reward taking part, and which ideas a player backs never changes them", async () => {
  await reset();
  const [a, b] = [await addIdea("A"), await addIdea("B")];
  await up(ALICE, a);
  await up(ALICE, b);
  await up(BOB, await noChange());
  assert.equal((await user(ALICE, "select my_progress() as p")).rows[0].p.points, 1);
  assert.equal((await user(BOB, "select my_progress() as p")).rows[0].p.points, 1);
  await up(ALICE, a);
  await up(ALICE, a);
  assert.equal((await user(ALICE, "select my_progress() as p")).rows[0].p.points, 1);
});

test("a suggestion that gets built earns more than one that only reaches the board", async () => {
  await reset();
  await buildProposal(BOB);
  const { p } = (await user(BOB, "select my_progress() as p")).rows[0];
  assert.deepEqual([p.on_ballot, p.built, p.points], [1, 1, 25]);
});

test("a voting streak ends when a finished round is missed", async () => {
  await reset();
  const nothing = await noChange();
  const play = async (who: string[]) => {
    for (const uid of who) await up(uid, nothing);
    await endRound();
  };
  await play([ALICE, BOB]);
  await play([BOB]);
  await play([ALICE, BOB]);
  assert.equal((await user(ALICE, "select my_progress() as p")).rows[0].p.streak, 1);
  assert.equal((await user(BOB, "select my_progress() as p")).rows[0].p.streak, 3);
});

test("the leaderboard shows only named players with points, and is public", async () => {
  await reset();
  const id = await addIdea();
  await up(ALICE, id);
  await up(BOB, id);
  await setName(BOB, "Named Bob");
  await setName(OWNER, "Idle One");
  const board = await as("anon", "", "select * from leaderboard()");
  assert.deepEqual(board.rows, [{ name: "Named Bob", points: 1 }]);
});

test("accounts can use a username, but never a real email address", async () => {
  await reset();
  const add = (email: string) => db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1)`, [email]);
  await add("dragon_fan@players.ewpages.com");
  for (const bad of ["someone@gmail.com", "a@players.ewpages.com", "x@players.ewpages.com.evil.example", "UPPER@players.ewpages.com"]) {
    await assert.rejects(add(bad), /username/, bad);
  }
  await assert.rejects(db.query(`update auth.users set email = 'someone@gmail.com' where id = $1`, [ALICE]), /username/);
  await db.query(`delete from auth.users where email = 'dragon_fan@players.ewpages.com'`);
});

test("a data export includes the username", async () => {
  await reset();
  await db.query(`update auth.users set email = 'alice_1@players.ewpages.com' where id = $1`, [ALICE]);
  const { rows } = await user(ALICE, "select export_my_data() as data");
  assert.equal(rows[0].data.username, "alice_1");
  await db.query(`update auth.users set email = null where id = $1`, [ALICE]);
});

test("the public record shows suggestions at once, but never their text or a held reason", async () => {
  await reset();
  await user(ALICE, "select submit_proposal('Raw words that nobody has screened yet')");
  const first = await as("anon", "", "select * from public_proposals");
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].status, "pending");
  assert.equal(first.rows[0].title, null);
  assert.equal(first.rows[0].credit, null);
  assert.ok(!JSON.stringify(first.rows).includes("Raw words"));

  await db.query(`update proposals set status = 'held', reason = 'Secret screening note'`);
  const held = await as("anon", "", "select * from public_proposals");
  assert.equal(held.rows[0].reason, null);

  await setName(ALICE, "alice_1");
  await db.query(`update proposals set status = 'queued', reason = null, title = 'A clean summary'`);
  const passed = await as("anon", "", "select * from public_proposals");
  assert.equal(passed.rows[0].title, "A clean summary");
  assert.equal(passed.rows[0].credit, "alice_1");
});

test("new suggestions are noticed quickly, but runs still can't pile up", async () => {
  await reset();
  await user(ALICE, "select submit_proposal('First')");
  const first = (await service("select tick() as t")).rows[0].t;
  assert.equal(first.plan, true);
  assert.equal((await service("select tick() as t")).rows[0].t.plan, false);
  await db.query(`update settings set last_plan_dispatch_at = now() - interval '2 minutes'`);
  assert.equal((await service("select tick() as t")).rows[0].t.plan, true);
});

const release = () => db.exec(`insert into changes (kind, title) values ('vote', 'The first game')`);
const sized = async (title: string, size: string) => {
  const id = await addIdea(title);
  await db.query(`update ideas set size = $1 where id = $2`, [size, id]);
  return id;
};
const need = async (id: number) => (await as("anon", "", `select need::int from board() where id = $1`, [id])).rows[0].need;
const crowd = async (size: number) => {
  await db.exec(`insert into auth.users (id) select ('20000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, ${size}) n`);
  await db.exec(`insert into participation (round, user_id) select 1, id from auth.users where id::text like '20000000-%'`);
};
const noCrowd = () => db.exec(`delete from auth.users where id::text like '20000000-%'`);

test("bigger ideas need more upvotes, scaled to active players", async () => {
  await reset();
  await release();
  const [s, m, l] = [await sized("S", "small"), await sized("M", "medium"), await sized("L", "major")];
  assert.deepEqual([await need(s), await need(m), await need(l)], [1, 1, 1]);
  await crowd(3);
  assert.deepEqual([await need(s), await need(m), await need(l)], [1, 1, 1]);
  await noCrowd();
  await crowd(4);
  assert.deepEqual([await need(s), await need(m), await need(l)], [1, 1, 2]);
  await noCrowd();
  await crowd(20);
  assert.deepEqual([await need(s), await need(m), await need(l)], [1, 5, 7]);
  await noCrowd();
});

test("the first game needs only one upvote, whatever its size", async () => {
  await reset();
  assert.equal(await need(await sized("L", "major")), 1);
});

test("an idea short of its target can't win, keeps its votes, and a smaller idea can win", async () => {
  await reset();
  await release();
  await crowd(6);
  const [big, small] = [await sized("Big", "major"), await sized("Small", "small")];
  await up(ALICE, big);
  await up(BOB, big);
  await up(ALICE, small);
  const { build } = await endRound();
  await noCrowd();
  assert.equal((await ballot(build[0])).question, "Small");
  assert.equal((await idea(big)).status, "open");
  const { rows } = await as("anon", "", `select votes::int from board() where id = $1`, [big]);
  assert.equal(rows[0].votes, 2);
});

test("if no idea reaches its target, nothing changes and the board says so", async () => {
  await reset();
  await release();
  await crowd(6);
  const big = await sized("Big", "major");
  await up(ALICE, big);
  assert.deepEqual((await endRound()).build, []);
  await noCrowd();
  assert.match((await round()).last_round_result, /no idea reached its upvote target/);
  assert.equal((await idea(big)).status, "open");
});

test("a major idea wins once it reaches its target", async () => {
  await reset();
  await release();
  await crowd(6);
  const big = await sized("Big", "major");
  for (const uid of [ALICE, BOB, OWNER]) await up(uid, big);
  assert.equal((await endRound()).build.length, 1);
  await noCrowd();
});

test("a lone player can pass a major idea", async () => {
  await reset();
  await release();
  const big = await sized("Big", "major");
  await up(ALICE, big);
  assert.equal((await endRound()).build.length, 1);
});

test("only the owner can change an idea's size", async () => {
  await reset();
  const id = await sized("Idea", "small");
  await assert.rejects(user(ALICE, `select set_idea_size($1, 'major')`, [id]));
  await user(OWNER, `select set_idea_size($1, 'major')`, [id]);
  assert.equal((await idea(id)).size, "major");
  await assert.rejects(user(OWNER, `select set_idea_size($1, 'huge')`, [id]));
});

test("functions the site and pipeline call name the settings row in every update", () => {
  const latest = readFileSync("supabase/migrations/0013_safe_updates.sql", "utf8");
  assert.equal(latest.match(/update settings set [^;]*;/g)?.every((sql) => sql.includes(" where ")), true);
});

test("the winner stays on the board until the build ends, and can't be voted on", async () => {
  await reset();
  const id = await addIdea("Winner");
  await up(ALICE, id);
  const { build } = await endRound();
  const shown = async () => (await as("anon", "", `select title, building from board() where id = $1`, [id])).rows;
  assert.deepEqual(await shown(), [{ title: "Winner", building: true }]);
  await assert.rejects(up(BOB, id));
  await service(`select complete_build($1, true, 'v1', 'Winner', 'Done')`, [build[0]]);
  assert.deepEqual(await shown(), []);
});

test("the owner sees spending and what's left, and nobody else can", async () => {
  await db.exec(`delete from ai_spend`);
  await user(OWNER, "select set_ai_credit(50)");
  await db.exec(`insert into ai_spend (job, input_tokens, output_tokens, dollars, created_at) values ('plan', 1000, 1000, 2.5, now() + interval '1 second')`);
  const { rows } = await user(OWNER, "select spending_summary() as s");
  assert.equal(Number(rows[0].s.left), 47.5);
  assert.equal(Number(rows[0].s.today), 2.5);
  await assert.rejects(user(ALICE, "select spending_summary()"));
  await assert.rejects(user(ALICE, "select set_ai_credit(1)"));
  await assert.rejects(user(ALICE, "select * from ai_spend"));
  await assert.rejects(user(OWNER, "select set_ai_credit(-1)"));
});
