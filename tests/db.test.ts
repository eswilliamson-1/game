import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const OWNER = "00000000-0000-0000-0000-000000000001";
const ALICE = "00000000-0000-0000-0000-000000000002";
const BOB = "00000000-0000-0000-0000-000000000003";

let db: PGlite;

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
    truncate votes, options, ballots, proposals, changes, profiles restart identity cascade;
    update settings set paused = false, launch_review = false, last_plan_dispatch_at = null;
  `);
}

async function openBallot(labels = ["Add a dragon"]) {
  const options = JSON.stringify(labels.map((label) => ({ label, spec: { title: label } })));
  const { rows } = await service(
    `select create_ballot('What next?', 'ai', null, $1::jsonb, false) as id`,
    [options],
  );
  const id = rows[0].id as number;
  const opts = await service(`select id, label, is_no_change from options where ballot_id = $1 order by id`, [id]);
  return { id, options: opts.rows };
}

const expire = (id: number) => db.query(`update ballots set closes_at = now() - interval '1 minute' where id = $1`, [id]);
const ballot = async (id: number) => (await db.query<Record<string, any>>(`select * from ballots where id = $1`, [id])).rows[0];

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(readFileSync("supabase/migrations/0001_init.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0003_accounts_privacy.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0005_username_accounts.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/0006_login_names.sql", "utf8"));
  await db.query(`insert into owners values ($1)`, [OWNER]);
});

test("every ballot gets the 'do not do this change' option", async () => {
  await reset();
  const { options } = await openBallot();
  assert.equal(options.filter((o) => o.is_no_change).length, 1);
  assert.equal(options.at(-1)!.label, "Do not do this change");
});

test("only one ballot can be active", async () => {
  await reset();
  await openBallot();
  await assert.rejects(openBallot());
});

test("no votes means nothing moves and the ballot stays open", async () => {
  await reset();
  const { id } = await openBallot();
  await expire(id);
  const { rows } = await service(`select tick() as r`);
  assert.deepEqual(rows[0].r.build, []);
  const b = await ballot(id);
  assert.equal(b.status, "open");
  assert.ok(new Date(b.closes_at) > new Date());
});

test("one vote is enough to move forward", async () => {
  await reset();
  const { id, options } = await openBallot();
  await user(ALICE, `select cast_vote($1, $2)`, [id, options[0].id]);
  await expire(id);
  const { rows } = await service(`select tick() as r`);
  assert.deepEqual(rows[0].r.build, [id]);
  assert.equal((await ballot(id)).status, "building");
});

test("ties go to 'do not do this change'", async () => {
  await reset();
  const { id, options } = await openBallot(["Add a dragon", "Add a castle"]);
  await user(ALICE, `select cast_vote($1, $2)`, [id, options[0].id]);
  await user(BOB, `select cast_vote($1, $2)`, [id, options[1].id]);
  await expire(id);
  await service(`select tick()`);
  const b = await ballot(id);
  assert.equal(b.status, "closed");
  assert.equal(b.winner_option_id, options[2].id);
});

test("voting again changes the vote instead of adding one", async () => {
  await reset();
  const { id, options } = await openBallot();
  await user(ALICE, `select cast_vote($1, $2)`, [id, options[0].id]);
  await user(ALICE, `select cast_vote($1, $2)`, [id, options[1].id]);
  const { rows } = await db.query<{ n: number }>(`select count(*)::int n from votes`);
  assert.equal(rows[0].n, 1);
});

test("voting needs a login and an option from that ballot", async () => {
  await reset();
  const { id, options } = await openBallot();
  await assert.rejects(as("anon", "", `select cast_vote($1, $2)`, [id, options[0].id]));
  await assert.rejects(user(ALICE, `select cast_vote($1, $2)`, [id, 999999]));
});

test("players can't write to tables directly or run pipeline functions", async () => {
  await reset();
  const { id, options } = await openBallot();
  await assert.rejects(user(ALICE, `insert into votes (ballot_id, user_id, option_id) values ($1, $2, $3)`, [id, ALICE, options[0].id]));
  await assert.rejects(user(ALICE, `update settings set paused = true`));
  await assert.rejects(user(ALICE, `update ballots set status = 'closed'`));
  await assert.rejects(user(ALICE, `select tick()`));
  await assert.rejects(user(ALICE, `select complete_build($1, true, 'v1', 'x', 'y')`, [id]));
  await assert.rejects(user(ALICE, `select create_ballot('q', 'ai', null, '[{"label":"x"}]', false)`));
});

test("players can't see each other's votes or proposal text", async () => {
  await reset();
  const { id, options } = await openBallot();
  await user(ALICE, `select cast_vote($1, $2)`, [id, options[0].id]);
  await user(ALICE, `select submit_proposal('Add a pet dragon')`);
  assert.equal((await user(BOB, `select * from votes`)).rows.length, 0);
  assert.equal((await user(BOB, `select * from proposals`)).rows.length, 0);
  assert.equal((await user(ALICE, `select * from proposals`)).rows.length, 1);
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
  for (let i = 0; i < 3; i++) await user(ALICE, `select submit_proposal($1)`, [`Idea ${i}`]);
  await assert.rejects(user(ALICE, `select submit_proposal('One more')`));
  await user(BOB, `select submit_proposal('A different player')`);
});

test("during launch review, ballots stay hidden until the owner approves", async () => {
  await reset();
  await db.exec(`update settings set launch_review = true`);
  const { id, options } = await openBallot();
  assert.equal((await ballot(id)).status, "pending_review");
  assert.equal((await user(ALICE, `select * from ballots`)).rows.length, 0);
  assert.equal((await user(ALICE, `select * from options`)).rows.length, 0);
  assert.equal((await user(ALICE, `select * from ballot_results($1)`, [id])).rows.length, 0);
  await assert.rejects(user(ALICE, `select cast_vote($1, $2)`, [id, options[0].id]));
  await assert.rejects(user(ALICE, `select review_ballot($1, true, '')`, [id]));
  await user(OWNER, `select review_ballot($1, true, '')`, [id]);
  assert.equal((await ballot(id)).status, "open");
});

test("a flagged ballot needs review even after the launch period", async () => {
  await reset();
  const { rows } = await service(`select create_ballot('q', 'ai', null, '[{"label":"x"}]', true) as id`);
  assert.equal((await ballot(rows[0].id)).status, "pending_review");
});

test("rejecting needs a public reason", async () => {
  await reset();
  await db.exec(`update settings set launch_review = true`);
  const { id } = await openBallot();
  await assert.rejects(user(OWNER, `select review_ballot($1, false, ' ')`, [id]));
  await user(OWNER, `select review_ballot($1, false, 'Breaks rule 8')`, [id]);
  assert.equal((await ballot(id)).outcome, "Breaks rule 8");
});

test("pausing stops the timer and voting, and is publicly logged", async () => {
  await reset();
  const { id, options } = await openBallot();
  await assert.rejects(user(ALICE, `select set_paused(true, 'x')`));
  await user(OWNER, `select set_paused(true, 'Security check')`);
  await assert.rejects(user(ALICE, `select cast_vote($1, $2)`, [id, options[0].id]));
  const { rows } = await service(`select tick() as r`);
  assert.equal(rows[0].r.paused, true);
  const log = await as("anon", "", `select kind, notes from changes`);
  assert.deepEqual(log.rows, [{ kind: "pause", notes: "Security check" }]);
});

test("a failed build is published and frees the slot for the next ballot", async () => {
  await reset();
  const { id, options } = await openBallot();
  await user(ALICE, `select cast_vote($1, $2)`, [id, options[0].id]);
  await expire(id);
  await service(`select tick()`);
  await service(`select complete_build($1, false, null, 'Add a dragon', 'Failed the frame rate test')`, [id]);
  assert.equal((await ballot(id)).status, "closed");
  const log = await as("anon", "", `select kind, notes from changes`);
  assert.deepEqual(log.rows, [{ kind: "failed", notes: "Failed the frame rate test" }]);
  await openBallot();
});

test("planning is throttled, and not while a ballot waits", async () => {
  await reset();
  assert.equal((await service(`select tick() as r`)).rows[0].r.plan, true);
  assert.equal((await service(`select tick() as r`)).rows[0].r.plan, false);
  await db.exec(`update settings set last_plan_dispatch_at = null`);
  await openBallot();
  assert.equal((await service(`select tick() as r`)).rows[0].r.plan, false);
});

test('the cycle starts fast and slows down as releases accumulate', async () => {
  await reset();
  const minutes = async () => {
    const { rows } = await service('select extract(epoch from cycle_interval()) / 60 as m');
    return Number(rows[0].m);
  };
  assert.equal(await minutes(), 30);
  await db.exec("insert into changes (kind, title) select 'vote', 'x' from generate_series(1, 10)");
  assert.equal(await minutes(), 120);
  await db.exec("insert into changes (kind, title) select 'vote', 'x' from generate_series(1, 15)");
  assert.equal(await minutes(), 360);
  await db.exec("insert into changes (kind, title) select 'failed', 'x' from generate_series(1, 50)");
  assert.equal(await minutes(), 360);
});

async function buildProposal(uid: string) {
  const { rows } = await user(uid, "select submit_proposal('Add a pet dragon') as id");
  const made = await service(
    "select create_ballot('Add it?', 'proposal', $1, '[{\"label\":\"Add it\"}]', false) as id",
    [rows[0].id],
  );
  const id = made.rows[0].id as number;
  const options = await service("select id from options where ballot_id = $1 order by id", [id]);
  await user(ALICE, "select cast_vote($1, $2)", [id, options.rows[0].id]);
  await expire(id);
  await service("select tick()");
  await service("select complete_build($1, true, 'v1', 'Pet dragon', 'Dragons now follow you')", [id]);
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
  const { id } = await openBallot();
  assert.equal((await ballot(id)).credit, "the AI");
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

test("points reward taking part, and the chosen option never changes them", async () => {
  await reset();
  const { id, options } = await openBallot();
  await user(ALICE, "select cast_vote($1, $2)", [id, options[0].id]);
  await user(BOB, "select cast_vote($1, $2)", [id, options.at(-1)!.id]);
  const alice = (await user(ALICE, "select my_progress() as p")).rows[0].p;
  const bob = (await user(BOB, "select my_progress() as p")).rows[0].p;
  assert.equal(alice.points, 1);
  assert.equal(bob.points, 1);

  await user(ALICE, "select cast_vote($1, $2)", [id, options.at(-1)!.id]);
  assert.equal((await user(ALICE, "select my_progress() as p")).rows[0].p.points, 1);
});

test("a suggestion that gets built earns more than one that only reaches a ballot", async () => {
  await reset();
  await buildProposal(BOB);
  const { p } = (await user(BOB, "select my_progress() as p")).rows[0];
  assert.deepEqual([p.on_ballot, p.built, p.points], [1, 1, 25]);
});

test("a voting streak ends when a finished ballot is missed", async () => {
  await reset();
  const vote = async (who: string[]) => {
    const { id, options } = await openBallot();
    for (const uid of who) await user(uid, "select cast_vote($1, $2)", [id, options.at(-1)!.id]);
    await expire(id);
    await service("select tick()");
  };
  await vote([ALICE, BOB]);
  await vote([BOB]);
  await vote([ALICE, BOB]);
  assert.equal((await user(ALICE, "select my_progress() as p")).rows[0].p.streak, 1);
  assert.equal((await user(BOB, "select my_progress() as p")).rows[0].p.streak, 3);
});

test("the leaderboard shows only named players with points, and is public", async () => {
  await reset();
  const { id, options } = await openBallot();
  await user(ALICE, "select cast_vote($1, $2)", [id, options[0].id]);
  await user(BOB, "select cast_vote($1, $2)", [id, options[0].id]);
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
