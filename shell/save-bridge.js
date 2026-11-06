// Answers the game's save requests for the logged-in player. Anything from the game
// is untrusted: a save is only ever stored as text and handed back, never shown or run,
// and the game is told nothing about who is playing.
const WRITE_GAP_MS = 5_000;

export function startSaveBridge(api, gameUrl, maxChars) {
  const gameOrigin = new URL(gameUrl, location.href).origin;
  const frame = () => document.querySelector("iframe.game");
  let pending = null;
  let timer = null;
  let lastWrite = 0;

  const write = async () => {
    clearTimeout(timer);
    timer = null;
    const job = pending;
    pending = null;
    if (!job) return;
    lastWrite = Date.now();
    job.reply(await api.storeGameSave(job.data).then(() => true, () => false));
  };

  const queue = (data, reply) => {
    pending?.reply(true);
    pending = { data, reply };
    if (timer) return;
    timer = setTimeout(write, Math.max(0, lastWrite + WRITE_GAP_MS - Date.now()));
  };

  window.addEventListener("message", async (event) => {
    const game = frame();
    if (!game || event.source !== game.contentWindow || event.origin !== gameOrigin) return;
    const { type, id, data } = event.data ?? {};
    if (!Number.isInteger(id)) return;
    const reply = (value) => event.source.postMessage({ type: "game-save:reply", id, value }, gameOrigin);
    const user = await api.user().catch(() => null);
    if (type === "game-save:load") {
      reply(user ? await api.loadGameSave().catch(() => null) : null);
    } else if (type === "game-save:store") {
      if (user && typeof data === "string" && data.length <= maxChars) queue(data, reply);
      else reply(false);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) write();
  });

  // A save belongs to one account, so the game restarts when the player changes.
  let player;
  const watch = async () => {
    const id = (await api.user().catch(() => null))?.id ?? null;
    const game = frame();
    if (player !== undefined && id !== player && game) game.src = game.src;
    player = id;
  };
  api.onAuthChange(() => {
    watch();
  });
  watch();
}
