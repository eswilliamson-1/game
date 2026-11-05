// Builds the voting site. Only the owner runs this, from their own computer.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { build } from "esbuild";
import settings from "../config/settings.json" with { type: "json" };

const OUT = "dist/shell";
const env = Object.fromEntries(
  (existsSync(".env") ? readFileSync(".env", "utf8") : "")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      return match ? [[match[1], match[2]]] : [];
    }),
);
const supabaseUrl = process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? "";
const supabaseKey = process.env.SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY ?? "";
const preview = !supabaseUrl;
if (!preview && !(settings.privacy.owner && settings.privacy.contact && settings.privacy.dataRegion)) {
  throw new Error("Fill in privacy in config/settings.json. The privacy page must say who runs the site.");
}
const gameUrl = preview ? "preview-game/" : `https://${settings.hosts.game}/`;

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function rulesHtml(): string {
  const items = readFileSync("config/RULES.md", "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\d+\.\s+\*\*(.+?)\*\*\s*(.*)$/);
      return match ? [`<li><strong>${escapeHtml(match[1])}</strong> ${escapeHtml(match[2])}</li>`] : [];
    });
  const changes = JSON.parse(readFileSync("config/rule-changes.json", "utf8")) as { date: string; change: string }[];
  const log = changes.length
    ? changes.map((c) => `<p><strong>${escapeHtml(c.date)}:</strong> ${escapeHtml(c.change)}</p>`).join("")
    : `<p class="muted">The rules haven't changed since launch.</p>`;
  return `<div class="narrow rules"><h1>Rules</h1><ol>${items.join("")}</ol><h2>Rule changes</h2>${log}</div>`;
}

function privacyHtml(): string {
  const { owner, contact, dataRegion, updated } = settings.privacy;
  const who = escapeHtml(owner || "the site owner");
  const reach = escapeHtml(contact || "the contact listed here");
  const region = escapeHtml(dataRegion || "the region listed here");
  return `<div class="narrow rules">
    <h1>Privacy</h1>
    <p class="muted">Last updated ${escapeHtml(updated)}</p>
    <section class="panel"><h2>Your data</h2><div id="my-data"></div></section>
    <p>This site is run by ${who}, who is responsible for your data. Contact: ${reach}.</p>
    <h2>What we keep</h2>
    <ul>
      <li><strong>Your username and password.</strong> The password is stored only as a secure hash, so nobody can read it. We don't ask for your email or your real name. Your username is public, so please don't use your real name.</li>
      <li><strong>Your votes</strong>, including which ideas you upvoted. Only totals are public, never who voted for what.</li>
      <li><strong>Your suggestions.</strong> The owner can read them. The public suggestions page lists when each one arrived and its status, and adds an AI-written summary and your username once it passes screening. Your original text is never public.</li>
      <li><strong>Public credit.</strong> Your username is shown when a suggestion of yours reaches the idea board or the patch notes, and on the leaderboard with your points and level.</li>
      <li><strong>Your points, level, and badges</strong>, worked out from the activity above.</li>
      <li><strong>Technical logs</strong>, including IP addresses, kept by our hosting and database providers for security.</li>
    </ul>
    <p>Suggestions that contain an email address or phone number are refused. Please leave out other personal details too.</p>
    <h2>Why we keep it</h2>
    <p>We use this data only to run the game: counting votes, running rounds, reviewing and building suggestions, giving credit, showing progress, and preventing abuse. The legal basis is our legitimate interest in running the game you chose to join. We don't sell your data or share it for advertising, and we use no ads, analytics, or tracking.</p>
    <h2>Who handles it</h2>
    <ul>
      <li><strong>Supabase</strong> stores accounts, votes, and suggestions in ${region}.</li>
      <li><strong>Anthropic</strong> processes suggestions to screen them and build changes.</li>
      <li><strong>Hostinger</strong> hosts the website.</li>
      <li><strong>GitHub</strong> runs the build system and publishes the game's code and change summaries, but never passwords or votes.</li>
    </ul>
    <p>Some of these providers may handle data outside your country, under their own data protection terms.</p>
    <h2>How long we keep it</h2>
    <ul>
      <li>The original text of a suggestion is removed 30 days after it's sent, or later if it's still waiting for review.</li>
      <li>Accounts with no activity for one year are deleted.</li>
      <li>Patch notes and game changes stay public, with credit changed to "a player" once an account is deleted.</li>
    </ul>
    <h2>Browser storage</h2>
    <p>The site stores only what it needs to keep you logged in, and the game may save its own progress in your browser. There are no tracking cookies, so there's no cookie banner.</p>
    <h2>Your rights</h2>
    <p>You can download or delete your data at any time using the buttons above. Depending on where you live, you may also have the right to correct your data, restrict or object to its use, and complain to your data protection authority. Accounts aren't tied to an identity, so we can only act on an account you're logged in to. A lost password can't be reset.</p>
    <h2>Age</h2>
    <p>You must be 16 or older to join. Anyone can play without joining. If you believe a younger child has joined, contact us and we'll remove any data we can identify.</p>
    <h2>Changes</h2>
    <p>We'll update this page if anything changes, and the date at the top will show when.</p>
  </div>`;
}

const PAGES: Record<string, { title: string; page: string; content: string }> = {
  "index.html": {
    title: "Play & vote",
    page: "home",
    content: `<div class="layout">
      <div class="stage">
        <iframe class="game" title="The community game" src="${gameUrl}" sandbox="allow-scripts allow-same-origin"></iframe>
        <div id="board-slot"></div>
      </div>
      <div id="side"></div>
    </div>`,
  },
  "patch-notes.html": {
    title: "Patch notes",
    page: "notes",
    content: `<div class="narrow"><h1>Patch notes</h1><div id="notes"></div></div>`,
  },
  "suggestions.html": {
    title: "Suggestions",
    page: "suggestions",
    content: `<div class="narrow"><h1>Suggestions</h1><p class="muted">Every suggestion is listed here as it comes in. The original text stays private, and a summary appears once it passes screening.</p><div id="suggestions"></div></div>`,
  },
  "rules.html": { title: "Rules", page: "rules", content: rulesHtml() },
  "privacy.html": { title: "Privacy", page: "privacy", content: privacyHtml() },
  "review.html": {
    title: "Review",
    page: "review",
    content: `<div class="narrow"><h1>Review</h1><div id="review"></div></div>`,
  },
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: ["shell/app.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: `${OUT}/app.js`,
  define: {
    "globalThis.__CONFIG__": JSON.stringify({
      supabaseUrl,
      supabaseKey,
      gameUrl,
      maxProposalChars: settings.proposal.maxChars,
    }),
  },
});

// Hostinger's CDN keeps scripts and styles for a week, so each build needs new URLs.
const version = createHash("sha256")
  .update(readFileSync(`${OUT}/app.js`))
  .update(readFileSync("shell/style.css"))
  .digest("hex")
  .slice(0, 12);
const template = readFileSync("shell/page.html", "utf8");
for (const [file, page] of Object.entries(PAGES)) {
  writeFileSync(
    `${OUT}/${file}`,
    template
      .replaceAll("{{title}}", () => escapeHtml(page.title))
      .replaceAll("{{siteName}}", () => escapeHtml(settings.siteName))
      .replaceAll("{{page}}", () => page.page)
      .replaceAll("{{version}}", () => version)
      .replaceAll("{{content}}", () => page.content),
  );
}
cpSync("shell/style.css", `${OUT}/style.css`);

if (preview) {
  cpSync("game", `${OUT}/preview-game`, { recursive: true });
} else {
  const supabase = new URL(supabaseUrl).origin;
  const csp = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${supabase} ${supabase.replace("https:", "wss:")}; frame-src https://${settings.hosts.game}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  writeFileSync(
    `${OUT}/.htaccess`,
    `<IfModule mod_headers.c>\n  Header always set Content-Security-Policy "${csp}"\n  Header always set Cache-Control "no-cache"
  Header always set X-Content-Type-Options "nosniff"\n  Header always set Referrer-Policy "strict-origin-when-cross-origin"\n</IfModule>\nOptions -Indexes\n<IfModule mod_rewrite.c>\n  RewriteEngine On\n  RewriteCond %{HTTP_HOST} !^${settings.hosts.vote.replaceAll(".", "\\.")}$ [NC]\n  RewriteRule ^ - [F]\n</IfModule>\n`,
  );
}
console.log(`Built the voting site${preview ? " in preview mode" : ""}.`);
