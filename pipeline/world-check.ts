// Tries shared play on the live site with two throwaway logged-in players, then deletes
// them. It's the only check that holds the service key, and only to make those accounts.
import { randomBytes } from "node:crypto";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

const URL_BASE = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_BASE, process.env.SUPABASE_SERVICE_KEY!, options);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
};

const made: string[] = [];
async function player() {
  const email = `probe_${randomBytes(6).toString("hex")}@players.ewpages.com`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  made.push(data.user.id);
  const client = createClient(URL_BASE, ANON, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  await client.realtime.setAuth(signedIn.data.session.access_token);
  return client;
}

const joined = (channel: RealtimeChannel) =>
  new Promise<string>((resolve) => {
    channel.subscribe((status) => {
      if (status !== "CLOSED") resolve(status);
    });
    setTimeout(() => resolve("no answer"), 10_000);
  });

const room = (client: SupabaseClient, heard: unknown[], isPrivate = true) =>
  client.channel("world", { config: { private: isPrivate } }).on("broadcast", { event: "move" }, ({ payload }) => heard.push(payload));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const [alice, bob] = [await player(), await player()];
  const stranger = createClient(URL_BASE, ANON, options);

  const state = await stranger.rpc("world_state");
  check("Strangers can read the shared world", !state.error && Array.isArray(state.data?.counters), state.error?.message);

  const mark = () => alice.rpc("world_mark", { p_x: 1, p_y: 2, p_z: 3, p_kind: 4 });
  check("A player can leave a mark", (await mark()).data === true);
  check("Marks are rate limited", (await mark()).data === false);
  check("Out of range marks are refused", Boolean((await bob.rpc("world_mark", { p_x: 1e9, p_y: 0, p_z: 0, p_kind: 0 })).error));
  const seen = await bob.rpc("world_state");
  const found = seen.data?.marks?.find((m: { x: number; y: number }) => m.x === 1 && m.y === 2);
  check("Marks don't say who left them", Boolean(found) && Object.keys(found).sort().join() === "kind,mine,x,y,z", JSON.stringify(found));
  check("Another player's mark isn't flagged as theirs", found?.mine === false);

  const [aliceHeard, bobHeard, strangerHeard, openHeard]: unknown[][] = [[], [], [], []];
  const aliceRoom = room(alice, aliceHeard);
  const bobRoom = room(bob, bobHeard);
  const strangerRoom = room(stranger, strangerHeard);
  const openRoom = room(stranger, openHeard, false);
  const statuses = await Promise.all([joined(aliceRoom), joined(bobRoom)]);
  check("Logged-in players can join the live room", statuses.every((s) => s === "SUBSCRIBED"), statuses.join());
  const strangerStatus = await joined(strangerRoom);
  check("Strangers can't join the live room", strangerStatus !== "SUBSCRIBED", strangerStatus);
  await joined(openRoom);

  await wait(1000);
  await aliceRoom.send({ type: "broadcast", event: "move", payload: { x: 5 } });
  await wait(3000);
  check("Logged-in players hear each other", bobHeard.length === 1, `${bobHeard.length} heard`);
  check("A stranger hears nothing from the live room", strangerHeard.length === 0, `${strangerHeard.length} heard`);
  check("The open channel of the same name hears nothing", openHeard.length === 0, `${openHeard.length} heard`);

  await openRoom.send({ type: "broadcast", event: "move", payload: { x: 6 } });
  await wait(3000);
  check("A stranger can't inject into the live room", bobHeard.length === 1, `${bobHeard.length} heard`);

  const other = bob.channel("elsewhere", { config: { private: true } });
  const otherStatus = await joined(other);
  check("Other private channels stay closed", otherStatus !== "SUBSCRIBED", otherStatus);

  await Promise.all([alice, bob, stranger].map((client) => client.removeAllChannels()));
} catch (error) {
  check("Shared play check finished", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const id of made) {
    const { error } = await admin.auth.admin.deleteUser(id);
    check("Throwaway player deleted", !error, error?.message);
  }
}

process.exit(failed ? 1 : 0);
