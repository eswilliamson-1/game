// Answers the game's shared play requests. The game and other players are both
// untrusted, so everything passes through cleanMove, which keeps only a few numbers:
// a player can't get text, names, or anything else to another player's game.
const SEND_GAP_MS = 334;
const RESEND_MS = 4_000;
const SEEN_GAP_MS = 150;
const GONE_MS = 10_000;
const TELL_MS = 200;
const MAX_OTHERS = 16;
const RANGE = 100_000;
const SENDER = /^[0-9a-f-]{36}$/;

const coordinate = (value) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= RANGE ? Math.round(value * 100) / 100 : null;

export function cleanMove(raw) {
  const numbers = [raw?.x, raw?.y, raw?.z, raw?.heading].map(coordinate);
  const action = raw?.action;
  if (numbers.includes(null) || !Number.isInteger(action) || action < 0 || action > 31) return null;
  const [x, y, z, heading] = numbers;
  return { x, y, z, heading, action };
}

export function startWorldBridge(api, gameUrl) {
  const gameOrigin = new URL(gameUrl, location.href).origin;
  const frame = () => document.querySelector("iframe.game");
  const others = new Map();
  let room = null;
  let joining = false;
  let company = 0;
  let nextId = 1;
  let changed = false;
  let ticker = null;
  let lastSent = 0;
  let lastMove = "";

  const tell = () => {
    const now = Date.now();
    for (const [key, other] of others) {
      if (now - other.seen > GONE_MS) {
        others.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    changed = false;
    const players = [...others.values()].map(({ id, move }) => ({ id, ...move }));
    frame()?.contentWindow?.postMessage({ type: "game-world:players", players }, gameOrigin);
  };

  const hear = (payload) => {
    const move = cleanMove(payload);
    const key = payload?.from;
    if (!move || typeof key !== "string" || !SENDER.test(key)) return;
    const now = Date.now();
    const other = others.get(key);
    if (other && now - other.seen < SEEN_GAP_MS) return;
    if (!other && others.size >= MAX_OTHERS) return;
    others.set(key, { id: other?.id ?? nextId++, move, seen: now });
    changed = true;
  };

  const leave = () => {
    clearInterval(ticker);
    ticker = null;
    room?.leave().catch(() => {});
    room = null;
    company = 0;
    changed = others.size > 0;
    others.clear();
    tell();
  };

  const join = async () => {
    if (room) return true;
    if (joining || !(await api.user().catch(() => null))) return false;
    joining = true;
    try {
      room = await api.joinLive({
        onMove: hear,
        onCount: (count) => {
          company = count;
        },
        onLeave: (key) => {
          changed = others.delete(key) || changed;
        },
      });
      ticker = setInterval(tell, TELL_MS);
      return true;
    } catch {
      return false;
    } finally {
      joining = false;
    }
  };

  // Nothing is sent while a player is alone, so solo play costs almost nothing.
  const send = (move) => {
    if (!room || !move || company < 1) return;
    const now = Date.now();
    const same = JSON.stringify(move) === lastMove;
    if (now - lastSent < (same ? RESEND_MS : SEND_GAP_MS)) return;
    lastSent = now;
    lastMove = JSON.stringify(move);
    room.send(move).catch(() => {});
  };

  const requests = {
    "game-world:state": () => api.worldState(),
    "game-world:mark": ({ x, y, z, kind }) => api.worldMark(x, y, z, kind),
    "game-world:add": ({ slot, amount }) => api.worldAdd(slot, amount),
    "game-world:join": join,
  };

  window.addEventListener("message", async (event) => {
    const game = frame();
    if (!game || event.source !== game.contentWindow || event.origin !== gameOrigin) return;
    const message = event.data ?? {};
    if (message.type === "game-world:move") return send(cleanMove(message.move));
    if (message.type === "game-world:leave") return leave();
    if (!Object.hasOwn(requests, message.type ?? "") || !Number.isInteger(message.id)) return;
    const failed = message.type === "game-world:state" ? null : false;
    const value = await requests[message.type](message).catch(() => failed);
    event.source.postMessage({ type: "game-save:reply", id: message.id, value }, gameOrigin);
  });

  api.onAuthChange(async () => {
    if (room && !(await api.user().catch(() => null))) leave();
  });
}
