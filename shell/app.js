import { liveApi, previewApi } from "./api.js";
import { startSaveBridge } from "./save-bridge.js";
import { startWorldBridge } from "./world-bridge.js";

const config = globalThis.__CONFIG__;
const api = config.supabaseUrl ? liveApi(config.supabaseUrl, config.supabaseKey) : previewApi();

// Everything from the database is written with textContent, never as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

const $ = (id) => document.getElementById(id);

const pad = (n) => String(n).padStart(2, "0");

function clock(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours}:${pad(minutes)}` : minutes}:${pad(seconds % 60)}`;
}

function windowLabel(minutes) {
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

let closesAt = null;
let buildRunning = false;

function tickCountdown() {
  const box = $("ballot-time");
  if (!box || !closesAt) return;
  const seconds = Math.ceil((new Date(closesAt) - Date.now()) / 1000);
  // One build runs at a time, so a round can't end until the current one is done.
  if (buildRunning) box.textContent = "Voting stays open. This round ends once the current build finishes.";
  else box.textContent = seconds > 0 ? `Round ends in ${clock(seconds)}` : "The round is ending now. The result appears in a few seconds.";
}

function showError(target, error) {
  target.replaceChildren(el("p", { class: "error", textContent: error.message }));
}

function showFailure(error) {
  const notice = $("notice");
  notice.hidden = false;
  notice.textContent = `Something went wrong: ${error.message}`;
}

const LIVE_UPDATE_MS = 10_000;
const BUILD_STAGE = {
  writing: "Step 1 of 3: the AI is writing the change.",
  testing: "Step 2 of 3: playing it to check it works and runs smoothly.",
  fixing: "Step 2 of 3: testing found a problem, so the AI is trying to fix it.",
  publishing: "Step 3 of 3: publishing it to the site.",
};
let wasBuilding = false;

async function renderBuildStatus() {
  const box = $("build-status");
  const build = await api.building();
  buildRunning = Boolean(build);
  if (build) {
    wasBuilding = true;
    box.hidden = false;
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(build.startedAt)) / 60_000));
    box.textContent = `Building now: ${build.label}. ${BUILD_STAGE[build.stage]} Running for ${minutes} min.`;
  } else if (wasBuilding) {
    wasBuilding = false;
    box.replaceChildren("The build has finished. ", el("a", { href: "patch-notes.html", textContent: "See the result" }), ".");
    const game = document.querySelector("iframe.game");
    if (game) game.src = game.src;
  } else if (!box.firstElementChild) {
    box.hidden = true;
  }
}

const guarded = (action) => () => action().then(refresh).catch(showFailure);

async function renderAccount(user) {
  const box = $("account");
  if (!user) {
    box.replaceChildren(el("span", { textContent: "Not logged in" }));
    return;
  }
  const [name, owner, progress] = await Promise.all([api.myName(user.id), api.isOwner(), api.myProgress()]);
  box.replaceChildren(
    el("span", { textContent: name || "Player" }),
    levelButton(progress),
    owner ? el("a", { href: "review.html", textContent: "Review" }) : "",
    el("a", { href: "privacy.html", textContent: "Your data" }),
    el("button", { class: "secondary", textContent: "Log out", onclick: guarded(() => api.signOut()) }),
  );
}

function accountForm() {
  const username = el("input", { id: "username", required: true, minLength: 3, maxLength: 24, pattern: "[A-Za-z0-9_\\-]+", autocomplete: "username" });
  const password = el("input", { id: "password", type: "password", required: true, minLength: 8, autocomplete: "current-password" });
  const age = el("input", { type: "checkbox", id: "age" });
  const status = el("div");
  const form = el("form", { onsubmit: (event) => event.preventDefault() });
  const submit = (action) => async () => {
    if (!form.reportValidity()) return;
    try {
      await action(username.value.trim(), password.value);
      refresh();
    } catch (error) {
      showError(status, error);
    }
  };
  const create = async (name, secret) => {
    if (!age.checked) throw new Error("Please confirm you're 16 or older to create an account.");
    await api.signUp(name, secret);
  };
  form.append(
    el("h2", { textContent: "Log in to vote and suggest changes" }),
    el("label", { htmlFor: "username", textContent: "Username, shown publicly (letters, numbers, dashes, and underscores)" }),
    username,
    el("label", { htmlFor: "password", textContent: "Password (at least 8 characters)" }),
    password,
    el("p", { class: "muted", textContent: "No email needed. That also means a lost password can't be reset, so keep it somewhere safe." }),
    el("label", { class: "check" }, age, " New here? I'm 16 or older and have read the ", el("a", { href: "privacy.html", textContent: "privacy notice" }), "."),
    el(
      "div",
      { class: "row" },
      el("button", { type: "button", class: "primary", textContent: "Create account", onclick: submit(create) }),
      el("button", { type: "button", class: "secondary", textContent: "Log in", onclick: submit((name, secret) => api.signIn(name, secret)) }),
    ),
    status,
  );
  return form;
}

const SIZE_NAME = { small: "Small change", medium: "Medium change", major: "Major change" };

function sizeLabel(idea, votes) {
  const need = Number(idea.need);
  if (need <= 1) return SIZE_NAME[idea.size];
  return votes >= need ? `${SIZE_NAME[idea.size]}: has its ${need} upvotes` : `${SIZE_NAME[idea.size]}: ${votes} of ${need} upvotes needed`;
}

function boardPanel(ideas, round, user, windowMinutes) {
  const top = Math.max(1, ...ideas.map((idea) => Number(idea.votes)));
  const status = el("div");
  closesAt = round.round_closes_at;
  const buttons = ideas.map((idea) => {
    const votes = Number(idea.votes);
    const bar = el("span", { class: "bar" });
    bar.style.width = `${Math.round((votes / top) * 100)}%`;
    const vote = el(
      "button",
      {
        class: "option",
        disabled: !user || idea.building,
        "aria-pressed": String(idea.mine),
        onclick: async () => {
          try {
            await api.upvote(idea.id);
            await updateHome();
          } catch (error) {
            showError(status, error);
          }
        },
      },
      bar,
      el("span", { class: "label" }, el("span", { textContent: idea.title }), el("span", { textContent: `${idea.mine ? "▲ " : ""}${votes}` })),
      idea.summary ? el("span", { class: "detail", textContent: idea.summary }) : null,
      idea.is_no_change ? null : el("span", { class: "detail", textContent: `Suggested by ${idea.credit}` }),
      idea.is_no_change ? null : el("span", { class: `size ${idea.building || votes >= Number(idea.need) ? "ready" : ""}`, textContent: idea.building ? "Won, and being built now" : sizeLabel(idea, votes) }),
    );
    const down = idea.is_no_change || idea.building
      ? null
      : el("button", {
          class: "down",
          disabled: !user,
          "aria-pressed": String(Boolean(idea.mine_down)),
          "aria-label": `Downvote ${idea.title}`,
          textContent: `▼ ${Number(idea.downvotes ?? 0)}`,
          onclick: async () => {
            try {
              await api.downvote(idea.id);
              await updateHome();
            } catch (error) {
              showError(status, error);
            }
          },
        });
    return el("div", { class: idea.is_no_change ? "idea nothing" : "idea" }, vote, down);
  });
  return el(
    "section",
    { class: "panel", id: "board" },
    el("h2", { textContent: `Idea board · Round ${round.round_number}` }),
    el("p", { class: "muted", textContent: "Upvote as many ideas as you like, and downvote the ones you don't want. Enough downvotes remove an idea. When the round ends, the top idea that has reached its upvote target gets built. Bigger changes need more upvotes, and a tie changes nothing." }),
    el("div", { class: "ideas" }, ...buttons),
    closesAt
      ? el("p", { class: "countdown", id: "ballot-time" })
      : el("p", { class: "muted", textContent: `No votes this round, so the clock hasn't started. Once someone votes, the round ends within ${windowLabel(windowMinutes)}.` }),
    round.last_round_result ? el("p", { class: "muted", textContent: round.last_round_result }) : null,
    status,
  );
}

function proposalPanel(user) {
  const body = el("textarea", { id: "proposal", maxLength: config.maxProposalChars, required: true });
  const status = el("div");
  return el(
    "section",
    { class: "panel" },
    el("h2", { textContent: "Suggest a change" }),
    user
      ? el(
          "form",
          {
            onsubmit: async (event) => {
              event.preventDefault();
              try {
                await api.propose(body.value);
                body.value = "";
                status.replaceChildren(el("p", { class: "success", textContent: "Thanks. It will be checked against the rules before it reaches the board." }));
              } catch (error) {
                showError(status, error);
              }
            },
          },
          el("label", { htmlFor: "proposal", textContent: `Your idea, in plain text (up to ${config.maxProposalChars} characters). Don't include personal details.` }),
          body,
          el("div", { class: "row" }, el("button", { class: "primary", textContent: "Submit" })),
          status,
        )
      : el("p", { class: "muted", textContent: "Log in below the game to suggest a change." }),
  );
}

const LEVELS = [
  { at: 0, name: "Newcomer" },
  { at: 10, name: "Regular" },
  { at: 30, name: "Contributor" },
  { at: 75, name: "Builder" },
  { at: 150, name: "Architect" },
];

const levelFor = (points) => LEVELS.findLast((level) => points >= level.at);

const BADGES = [
  { name: "First vote", earned: (p) => p.votes >= 1 },
  { name: "10 votes", earned: (p) => p.votes >= 10 },
  { name: "5 in a row", earned: (p) => p.streak >= 5 },
  { name: "On the board", earned: (p) => p.on_ballot >= 1 },
  { name: "Built by you", earned: (p) => p.built >= 1 },
];

function progressPanel(progress) {
  const level = levelFor(progress.points);
  const next = LEVELS.find((l) => l.at > progress.points);
  const fill = el("span");
  fill.style.width = next ? `${Math.round(((progress.points - level.at) / (next.at - level.at)) * 100)}%` : "100%";
  const badges = BADGES.filter((badge) => badge.earned(progress));
  return el(
    "section",
    { class: "panel", id: "progress" },
    el("h2", { textContent: `${level.name} · ${progress.points} points` }),
    el("div", { class: "meter" }, fill),
    el("p", { class: "muted", textContent: next ? `${next.at - progress.points} points to ${next.name}` : "You've reached the top level." }),
    progress.streak > 1 ? el("p", { textContent: `Voting streak: ${progress.streak} in a row` }) : null,
    badges.length ? el("p", {}, ...badges.map((badge) => el("span", { class: "tag badge", textContent: badge.name }))) : null,
    el("p", { class: "muted", textContent: "1 point for each round you vote in, 5 when your idea reaches the board, 20 when it's built. Which ideas you pick never affects your points." }),
  );
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function levelButton(progress) {
  return el("button", {
    id: "level",
    class: "secondary",
    textContent: `${levelFor(progress.points).name} · ${progress.points} points`,
    onclick: () => openProfile().catch(showFailure),
  });
}

function historyList(title, rows, empty) {
  return el(
    "section",
    { class: "history" },
    el("h3", { textContent: title }),
    ...(rows.length ? rows : [el("p", { class: "muted", textContent: empty })]),
  );
}

async function openProfile() {
  const [progress, data] = await Promise.all([api.myProgress(), api.exportData()]);
  const latest = (rows) => (rows ?? []).slice(-10).reverse();
  const dialog = el(
    "dialog",
    { class: "profile", id: "profile" },
    el("h2", { textContent: data.username ?? "Your profile" }),
    progressPanel(progress),
    el("p", {
      textContent: [
        count(progress.votes, "round played", "rounds played"),
        `${count(progress.on_ballot, "idea")} on the board`,
        `${progress.built} built`,
      ].join(" · "),
    }),
    historyList(
      "Your suggestions",
      latest(data.suggestions).map((s) =>
        el("p", {}, el("span", { textContent: s.text ?? "A suggestion" }), " ", el("span", { class: "tag", textContent: PROPOSAL_STATUS[s.status] ?? s.status })),
      ),
      "No suggestions yet.",
    ),
    historyList("Ideas you upvoted", latest(data.upvotes).map((u) => el("p", { textContent: u.idea })), "No upvotes yet."),
    el(
      "div",
      { class: "row" },
      el("button", { class: "primary", textContent: "Close", onclick: () => dialog.close() }),
      el("a", { href: "privacy.html", textContent: "Your data" }),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function playerRow(row, place) {
  const facts = [
    count(row.rounds, "round played", "rounds played"),
    `${count(row.on_board, "idea")} on the board`,
    `${row.built} built`,
  ];
  if (row.streak > 1) facts.push(`${row.streak}-round streak`);
  return el(
    "article",
    { class: "note player" },
    el("h2", { textContent: `${place + 1}. ${row.name}` }),
    el("p", { textContent: `${levelFor(row.points).name} · ${row.points} points` }),
    el("p", { class: "muted", textContent: facts.join(" · ") }),
    row.last_built ? el("p", { class: "muted", textContent: `Latest built: ${row.last_built}` }) : null,
  );
}

async function renderLeaderboard() {
  const rows = await api.leaderboard();
  $("players").replaceChildren(...(rows.length ? rows.map(playerRow) : [el("p", { class: "muted", textContent: "Nobody yet. Vote to get on the board." })]));
}

const PROPOSAL_STATUS = {
  pending: "being checked",
  held: "under review",
  queued: "being checked",
  on_ballot: "on the board",
  rejected: "rejected",
};

function proposalRow(p) {
  return el(
    "p",
    {},
    el("span", { textContent: p.title ?? "A suggestion" }),
    el("span", { class: "tag", textContent: PROPOSAL_STATUS[p.status] }),
    p.credit ? el("span", { class: "credit", textContent: ` by ${p.credit}` }) : null,
    p.reason ? el("span", { class: "muted", textContent: ` ${p.reason}` }) : null,
  );
}

async function boardSection(user) {
  const [ideas, round, windowMinutes] = await Promise.all([api.board(), api.round(), api.windowMinutes()]);
  return boardPanel(ideas, round, user, windowMinutes);
}

function recentPanel(proposals) {
  return el(
    "section",
    { class: "panel", id: "recent" },
    el("h2", { textContent: "Recent suggestions" }),
    ...proposals.map(proposalRow),
    proposals.length ? el("a", { href: "suggestions.html", textContent: "See all suggestions" }) : el("p", { class: "muted", textContent: "None yet." }),
  );
}

// Swaps single panels, so a suggestion being typed isn't wiped.
async function updateHome() {
  const user = await api.user();
  const [section, proposals, progress] = await Promise.all([
    boardSection(user),
    api.proposals(5),
    user ? api.myProgress() : null,
  ]);
  $("board").replaceWith(section);
  $("recent").replaceWith(recentPanel(proposals));
  if (progress) $("level")?.replaceWith(levelButton(progress));
  tickCountdown();
}

async function renderHome() {
  const user = await api.user();
  const [section, proposals, paused] = await Promise.all([boardSection(user), api.proposals(5), api.paused()]);
  $("board-slot").replaceChildren(section);
  $("suggest-slot").replaceChildren(proposalPanel(user));
  $("recent-slot").replaceChildren(recentPanel(proposals));
  const side = $("side");
  side.replaceChildren(
    user ? "" : el("section", { class: "panel" }, accountForm()),
    paused ? el("section", { class: "panel" }, el("p", { textContent: "The game is paused by the owner." })) : "",
  );
}

async function renderSuggestions() {
  const proposals = await api.proposals(200);
  $("suggestions").replaceChildren(
    ...proposals.map((p) =>
      el("article", { class: "note" }, proposalRow(p), el("p", { class: "muted", textContent: new Date(p.created_at).toLocaleString() })),
    ),
    ...(proposals.length ? [] : [el("p", { class: "muted", textContent: "No suggestions yet." })]),
  );
}

const KIND = { vote: "Released", fix: "Fix", failed: "Not built", rollback: "Rollback", pause: "Paused", resume: "Resumed" };

async function renderNotes() {
  const changes = await api.changes();
  $("notes").replaceChildren(
    ...changes.map((c) =>
      el(
        "article",
        { class: "note" },
        el("h2", {}, c.title, el("span", { class: "tag", textContent: KIND[c.kind] }), c.version ? el("span", { class: "tag", textContent: c.version }) : null),
        c.notes ? el("p", { textContent: c.notes }) : null,
        c.credit ? el("p", { class: "credit", textContent: `Suggested by ${c.credit}` }) : null,
        el(
          "p",
          { class: "muted" },
          new Date(c.created_at).toLocaleString(),
          c.kind === "vote" && c.version ? " · " : "",
          c.kind === "vote" && c.version ? el("a", { href: `${config.gameUrl}${c.version}/`, textContent: "Play this version" }) : null,
        ),
      ),
    ),
    ...(changes.length ? [] : [el("p", { class: "muted", textContent: "Nothing has been released yet." })]),
  );
}

function reviewButtons(onDecide) {
  const reason = el("input", { placeholder: "Public reason, needed to reject" });
  const status = el("div");
  const decide = (approve) => async () => {
    try {
      await onDecide(approve, reason.value);
      refresh();
    } catch (error) {
      showError(status, error);
    }
  };
  return el(
    "div",
    {},
    reason,
    el(
      "div",
      { class: "row" },
      el("button", { class: "primary", textContent: "Approve", onclick: decide(true) }),
      el("button", { class: "secondary", textContent: "Reject", onclick: decide(false) }),
    ),
    status,
  );
}

async function renderReview() {
  const box = $("review");
  const user = await api.user();
  if (!user) return box.replaceChildren(el("section", { class: "panel" }, accountForm()));
  if (!(await api.isOwner())) return box.replaceChildren(el("p", { textContent: "Only the site owner can use this page." }));

  const { ideas, proposals } = await api.reviewQueue();
  const onBoard = (await api.board()).filter((idea) => !idea.is_no_change);
  const spending = await api.spending();
  const money = (value) => `$${Number(value).toFixed(2)}`;
  const credit = el("input", { id: "credit", type: "number", min: "0", step: "0.01", placeholder: "Your balance in dollars" });
  const paused = await api.paused();
  const pauseReason = el("input", { placeholder: "Public reason" });
  const nameToClear = el("input", { placeholder: "Exact name to remove" });
  box.replaceChildren(
    el("h2", { textContent: "AI credits" }),
    el(
      "section",
      { class: "panel", id: "spending" },
      el("p", { textContent: spending.left === null ? "Enter your balance below to see an estimate of what's left." : `About ${money(spending.left)} left` }),
      el("p", { class: "muted", textContent: `Spent about ${money(spending.today)} in the last 24 hours and ${money(spending.month)} this month. This is an estimate that only counts game planning and builds, so check the Claude Console for your exact balance.` }),
      credit,
      el("div", { class: "row" }, el("button", { class: "secondary", textContent: "Update my balance", onclick: guarded(() => api.setCredit(Number(credit.value))) }), el("a", { href: "https://platform.claude.com/settings/billing", target: "_blank", rel: "noreferrer", textContent: "Open Claude Console billing" })),
    ),
    el("h2", { textContent: "Ideas waiting for approval" }),
    ...ideas.map((idea) =>
      el(
        "section",
        { class: "panel" },
        el("h3", { textContent: idea.title }),
        el("p", { class: "credit", textContent: `Suggested by ${idea.credit}` }),
        el("p", { textContent: idea.spec?.summary ?? "" }),
        reviewButtons((approve, reason) => api.reviewIdea(idea.id, approve, reason)),
      ),
    ),
    ideas.length ? "" : el("p", { class: "muted", textContent: "Nothing waiting." }),
    el("h2", { textContent: "Idea sizes" }),
    ...onBoard.map((idea) =>
      el(
        "section",
        { class: "panel" },
        el("p", { textContent: `${idea.title}: ${SIZE_NAME[idea.size]}` }),
        el(
          "div",
          { class: "row" },
          ...Object.keys(SIZE_NAME).map((size) =>
            el("button", { class: "secondary", textContent: `Make ${size}`, disabled: idea.size === size, onclick: guarded(() => api.setIdeaSize(idea.id, size)) }),
          ),
        ),
      ),
    ),
    onBoard.length ? "" : el("p", { class: "muted", textContent: "No ideas on the board." }),
    el("h2", { textContent: "Proposals on hold" }),
    ...proposals.map((p) =>
      el(
        "section",
        { class: "panel" },
        el("p", { textContent: p.body }),
        el("p", { class: "muted", textContent: `Why it was held: ${p.reason ?? "unknown"}` }),
        reviewButtons((approve, reason) => api.reviewProposal(p.id, approve, reason)),
      ),
    ),
    proposals.length ? "" : el("p", { class: "muted", textContent: "Nothing on hold." }),
    el("h2", { textContent: "Emergency controls" }),
    el(
      "section",
      { class: "panel" },
      pauseReason,
      el(
        "div",
        { class: "row" },
        el("button", {
          class: "secondary",
          textContent: paused ? "Resume the game" : "Pause the game",
          onclick: guarded(() => api.setPaused(!paused, pauseReason.value)),
        }),
      ),
      el("p", { class: "muted", textContent: "Use is logged publicly. To roll back, run the Rollback workflow on GitHub." }),
      nameToClear,
      el(
        "div",
        { class: "row" },
        el("button", { class: "secondary", textContent: "Remove player name", onclick: guarded(() => api.clearName(nameToClear.value)) }),
      ),
    ),
  );
}

function saveJson(data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  el("a", { href: url, download: "my-game-data.json" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderPrivacy() {
  const box = $("my-data");
  const user = await api.user();
  if (!user) return box.replaceChildren(el("p", { class: "muted", textContent: "Log in to download or delete your data." }));
  const remove = async () => {
    if (confirm("Delete your account and data? This can't be undone.")) await api.deleteAccount();
  };
  box.replaceChildren(
    el("p", { class: "muted", textContent: "Deleting removes your account, votes, suggestions, and points, and changes any credit to \"a player\". Changes already built stay in the game." }),
    el(
      "div",
      { class: "row" },
      el("button", { class: "secondary", textContent: "Download my data", onclick: () => api.exportData().then(saveJson).catch(showFailure) }),
      el("button", { class: "secondary", textContent: "Delete my account", onclick: guarded(remove) }),
    ),
  );
}

const PAGES = { home: renderHome, leaderboard: renderLeaderboard, notes: renderNotes, suggestions: renderSuggestions, review: renderReview, privacy: renderPrivacy };

async function refresh() {
  try {
    await renderAccount(await api.user());
    await renderBuildStatus();
    await PAGES[document.body.dataset.page]?.();
    tickCountdown();
    if (!api.preview) $("notice").hidden = true;
  } catch (error) {
    showFailure(error);
  }
}

if (api.preview) {
  const notice = $("notice");
  notice.hidden = false;
  notice.textContent = "Preview with sample data. Nothing here is saved.";
}
api.onAuthChange(refresh);
refresh();
startSaveBridge(api, config.gameUrl, config.maxSaveChars);
startWorldBridge(api, config.gameUrl);
// Pages with forms of their own, like Review, are left alone.
const LIVE_PAGES = { home: updateHome, leaderboard: renderLeaderboard, notes: renderNotes, suggestions: renderSuggestions };

setInterval(() => {
  if (document.hidden) return;
  Promise.all([renderBuildStatus(), LIVE_PAGES[document.body.dataset.page]?.()]).catch(showFailure);
}, LIVE_UPDATE_MS);
setInterval(tickCountdown, 1000);
