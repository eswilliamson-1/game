import { liveApi, previewApi } from "./api.js";

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

function timeLeft(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return "closing soon";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

function showError(target, error) {
  target.replaceChildren(el("p", { class: "error", textContent: error.message }));
}

function showFailure(error) {
  const notice = $("notice");
  notice.hidden = false;
  notice.textContent = `Something went wrong: ${error.message}`;
}

const guarded = (action) => () => action().then(refresh).catch(showFailure);

async function renderAccount(user) {
  const box = $("account");
  if (!user) {
    box.replaceChildren(el("span", { textContent: "Not logged in" }));
    return;
  }
  const [name, owner] = await Promise.all([api.myName(user.id), api.isOwner()]);
  box.replaceChildren(
    el("span", { textContent: name || "No name set" }),
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
    el("label", { htmlFor: "username", textContent: "Username (letters, numbers, dashes, and underscores)" }),
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

function ballotPanel(ballot, user, mine) {
  const total = ballot.results.reduce((n, r) => n + Number(r.votes), 0);
  const canVote = user && ballot.status === "open";
  const status = el("div");
  const options = ballot.options.map((option) => {
    const votes = Number(ballot.results.find((r) => r.option_id === option.id)?.votes ?? 0);
    const share = total ? Math.round((votes / total) * 100) : 0;
    const bar = el("span", { class: "bar" });
    bar.style.width = `${share}%`;
    return el(
      "button",
      {
        class: "option",
        disabled: !canVote,
        "aria-pressed": String(mine === option.id),
        onclick: async () => {
          try {
            await api.vote(ballot.id, option.id);
            refresh();
          } catch (error) {
            showError(status, error);
          }
        },
      },
      bar,
      el("span", { class: "label" }, el("span", { textContent: option.label }), el("span", { textContent: String(votes) })),
      option.spec?.summary ? el("span", { class: "detail", textContent: option.spec.summary }) : null,
    );
  });
  const state =
    ballot.status === "building"
      ? "Voting has closed. The winning change is being built."
      : total === 0
        ? "No votes yet. The game won't change until someone votes."
        : timeLeft(ballot.closes_at);
  return el(
    "section",
    { class: "panel", id: "ballot" },
    el("h2", { textContent: ballot.question }),
    el("p", { class: "credit", textContent: `Suggested by ${ballot.credit}` }),
    ...options,
    el("p", { class: "muted", textContent: state }),
    status,
  );
}

function proposalPanel(user, name) {
  const body = el("textarea", { id: "proposal", maxLength: config.maxProposalChars, required: true });
  const nameInput = el("input", { id: "display-name", value: name, maxLength: 24 });
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
                const wanted = nameInput.value.trim();
                if (wanted !== name) await (wanted ? api.setName(wanted) : api.removeName());
                await api.propose(body.value);
                body.value = "";
                status.replaceChildren(el("p", { class: "success", textContent: "Thanks. It will be checked against the rules before it reaches a ballot." }));
                renderAccount(user);
              } catch (error) {
                showError(status, error);
              }
            },
          },
          el("label", { htmlFor: "display-name", textContent: "Public name for the patch notes and leaderboard (optional, and best not your real name)" }),
          nameInput,
          el("label", { htmlFor: "proposal", textContent: `Your idea, in plain text (up to ${config.maxProposalChars} characters). Don't include personal details.` }),
          body,
          el("div", { class: "row" }, el("button", { class: "primary", textContent: "Submit" })),
          status,
        )
      : el("p", { class: "muted", textContent: "Log in above to suggest a change." }),
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
  { name: "On the ballot", earned: (p) => p.on_ballot >= 1 },
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
    el("p", { class: "muted", textContent: "1 point for voting, 5 when your idea reaches a ballot, 20 when it's built. Which option you pick never affects your points." }),
  );
}

function leaderboardPanel(rows) {
  return el(
    "section",
    { class: "panel", id: "leaderboard" },
    el("h2", { textContent: "Top players" }),
    rows.length
      ? el("ol", { class: "board" }, ...rows.map((row) => el("li", {}, el("span", { textContent: row.name }), el("span", { class: "muted", textContent: `${levelFor(row.points).name} · ${row.points}` }))))
      : el("p", { class: "muted", textContent: "Nobody yet. Set a public name to appear here." }),
  );
}

async function renderHome() {
  const user = await api.user();
  const [ballot, proposals, paused, name, progress, board] = await Promise.all([
    api.currentBallot(),
    api.recentProposals(),
    api.paused(),
    user ? api.myName(user.id) : "",
    user ? api.myProgress() : null,
    api.leaderboard(),
  ]);
  const mine = ballot && user ? await api.myVote(ballot.id, user.id) : null;
  const side = $("side");
  side.replaceChildren(
    user ? progressPanel(progress) : el("section", { class: "panel" }, accountForm()),
    paused ? el("section", { class: "panel" }, el("p", { textContent: "The game is paused by the owner." })) : "",
    ballot
      ? ballotPanel(ballot, user, mine)
      : el("section", { class: "panel" }, el("h2", { textContent: "Current vote" }), el("p", { class: "muted", textContent: "The next vote will appear here soon." })),
    proposalPanel(user, name),
    leaderboardPanel(board),
    el(
      "section",
      { class: "panel" },
      el("h2", { textContent: "Recent suggestions" }),
      ...proposals.map((p) =>
        el(
          "p",
          {},
          el("span", { textContent: p.title ?? "A suggestion" }),
          el("span", { class: "tag", textContent: p.status.replace("_", " ") }),
          p.reason ? el("span", { class: "muted", textContent: ` ${p.reason}` }) : null,
        ),
      ),
      proposals.length ? null : el("p", { class: "muted", textContent: "None yet." }),
    ),
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

  const { ballots, proposals } = await api.reviewQueue();
  const paused = await api.paused();
  const pauseReason = el("input", { placeholder: "Public reason" });
  const nameToClear = el("input", { placeholder: "Exact name to remove" });
  box.replaceChildren(
    el("h2", { textContent: "Ballots waiting for approval" }),
    ...ballots.map((b) =>
      el(
        "section",
        { class: "panel" },
        el("h3", { textContent: b.question }),
        el("p", { class: "credit", textContent: `Suggested by ${b.credit}` }),
        ...b.options.filter((o) => !o.is_no_change).map((o) => el("p", { textContent: `${o.label}: ${o.spec?.summary ?? ""}` })),
        reviewButtons((approve, reason) => api.reviewBallot(b.id, approve, reason)),
      ),
    ),
    ballots.length ? "" : el("p", { class: "muted", textContent: "Nothing waiting." }),
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

const PAGES = { home: renderHome, notes: renderNotes, review: renderReview, privacy: renderPrivacy };

async function refresh() {
  try {
    await renderAccount(await api.user());
    await PAGES[document.body.dataset.page]?.();
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
