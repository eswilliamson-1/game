import { z } from "zod";
import settings from "../../config/settings.json" with { type: "json" };

export const Spec = z.object({
  title: z.string(),
  summary: z.string(),
  changes: z.array(z.string()),
  player_impact: z.string(),
});
export type Spec = z.infer<typeof Spec>;

const LINK = /(https?:|www\.|[a-z0-9-]+\.(com|net|org|io|gg|ru|xyz)\b)/i;
const MARKUP = /(<[a-z/!?]|```|\{\{|\$\{)/i;
const HIDDEN = /[\u0001-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/;

type Check = { ok: true } | { ok: false; reason: string };

/** Runs before any AI sees a proposal. Mirrors submit_proposal in the database. */
export function precheck(text: string): Check {
  const body = text.trim();
  if (!body || body.length > settings.proposal.maxChars) {
    return { ok: false, reason: `Proposals must be 1 to ${settings.proposal.maxChars} characters.` };
  }
  if (LINK.test(body) || MARKUP.test(body)) {
    return { ok: false, reason: "Proposals must be plain text with no links or code." };
  }
  if (HIDDEN.test(body)) return { ok: false, reason: "Proposals can't contain hidden characters." };
  return { ok: true };
}

const CODE_LIKE = /(=>|[<>{}`;]|\bfunction\s*\(|\bimport\s|\brequire\(|\bdocument\.|\bwindow\.)/i;
const INSTRUCTION_LIKE =
  /(ignore (all |any |the )?(previous|prior|above)|system prompt|you are now|as an ai|new instructions|disregard|builder|the model|override)/i;

/**
 * The only text the builder ever receives. A spec describes player-facing
 * changes, so anything shaped like a link, code, or an instruction fails here
 * even if an AI screener approved it.
 */
export function validateSpec(input: unknown): Check {
  const parsed = Spec.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Spec is not in the required format." };
  const spec = parsed.data;
  if (!spec.title.trim() || spec.title.length > 80) return { ok: false, reason: "Spec title length is invalid." };
  if (!spec.summary.trim() || spec.summary.length > 400) return { ok: false, reason: "Spec summary length is invalid." };
  if (spec.player_impact.length > 300) return { ok: false, reason: "Spec impact is too long." };
  if (spec.changes.length < 1 || spec.changes.length > 5) return { ok: false, reason: "A spec needs 1 to 5 changes." };
  if (spec.changes.some((c) => c.length > 200)) return { ok: false, reason: "A spec change is too long." };

  const text = [spec.title, spec.summary, spec.player_impact, ...spec.changes].join("\n");
  if (LINK.test(text)) return { ok: false, reason: "Specs can't contain links." };
  if (HIDDEN.test(text.replaceAll("\n", " "))) return { ok: false, reason: "Specs can't contain hidden characters." };
  if (CODE_LIKE.test(text)) return { ok: false, reason: "Specs can't contain code." };
  if (INSTRUCTION_LIKE.test(text)) return { ok: false, reason: "Specs can't contain instructions to the AI." };
  return { ok: true };
}

export function specToText(spec: Spec): string {
  return [
    `Title: ${spec.title}`,
    `Summary: ${spec.summary}`,
    "Changes:",
    ...spec.changes.map((c) => `- ${c}`),
    `What players will notice: ${spec.player_impact}`,
  ].join("\n");
}

/** A generated path must stay inside the game folder and use an allowed file type. */
export function safeGamePath(path: string): Check {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*\.[a-z]+$/.test(path.replace(/\.[a-z]+$/, (m) => m))) {
    return { ok: false, reason: `Unsafe file path: ${path}` };
  }
  if (path.split("/").some((part) => part.startsWith(".") || part === "..")) {
    return { ok: false, reason: `Unsafe file path: ${path}` };
  }
  if (!settings.build.allowedExtensions.includes(ext)) {
    return { ok: false, reason: `File type not allowed: ${path}` };
  }
  return { ok: true };
}

export type GameFile = { path: string; content: string };

const BANNED: [RegExp, string][] = [
  [/\bfetch\s*\(/, "network call (fetch)"],
  [/XMLHttpRequest/, "network call (XMLHttpRequest)"],
  [/\bWebSocket\b/, "network call (WebSocket)"],
  [/\bWebTransport\b|RTCPeerConnection/, "network connection"],
  [/\bEventSource\b/, "network call (EventSource)"],
  [/sendBeacon/, "network call (sendBeacon)"],
  [/\bimportScripts\b|\bnew\s+(Shared)?Worker\b|serviceWorker/, "background worker"],
  [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/, "dynamic code"],
  [/\bimport\s*\(/, "dynamic import"],
  [/\batob\s*\(|\bbtoa\s*\(|fromCharCode|fromCodePoint|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i, "encoded or hidden text"],
  [/document\s*\.\s*cookie|indexedDB|\bcaches\b/, "browser storage outside the save system"],
  [/document\s*\.\s*(domain|write)/, "unsafe document access"],
  [/window\s*\.\s*(open|parent|top|opener|frameElement)|\b(parent|top)\s*\.\s*(location|postMessage|document)|\bpostMessage\b/, "access outside the game"],
  [/\blocation\s*(\.\s*(href|assign|replace|reload)|=)/, "page navigation"],
  [/navigator\s*\.\s*(userAgent|geolocation|clipboard|mediaDevices|credentials|language|platform)/, "reading player or device data"],
  [/\bnew\s+Date\b|\bDate\s*\.\s*now\b|\bIntl\b/, "date or time trigger (use performance.now)"],
  [/\bprompt\s*\(|\bconfirm\s*\(|\balert\s*\(/, "browser dialog"],
  [/https?:|\/\/[a-z0-9-]+\.[a-z]{2,}|\bdata:text\/html|javascript:/i, "external address"],
];

const BANNED_HTML: [RegExp, string][] = [
  [/<(input|textarea|select|form|iframe|object|embed|base|link\s+[^>]*rel=["']?(preload|prefetch|import))\b/i, "input field or embedded page"],
  [/contenteditable/i, "editable text"],
  [/<a\b/i, "outbound link"],
  [/<meta\s+[^>]*http-equiv/i, "meta redirect"],
  [/<script\b(?![^>]*\bsrc=["'][a-zA-Z0-9_/.-]+["'])[^>]*>/i, "inline script"],
  [/\son[a-z]+\s*=/i, "inline event handler"],
  [/<style\b|\sstyle\s*=/i, "inline style"],
];

const BANNED_DOM_CREATION = /createElement\s*\(\s*['"`](input|textarea|select|form|iframe|object|embed|a|script|link|meta|base)['"`]/i;
const BANNED_HTML_INJECTION = /\.(innerHTML|outerHTML|srcdoc)\s*=|insertAdjacentHTML/;

export type Violation = { path: string; problem: string };

/** Non-AI code scan. Anything found here blocks the release. */
export function scanFiles(files: GameFile[]): Violation[] {
  const found: Violation[] = [];
  const add = (path: string, problem: string) => found.push({ path, problem });

  if (files.length > settings.build.maxFiles) add("(all)", "Too many files.");
  if (!files.some((f) => f.path === "index.html")) add("(all)", "Missing index.html.");
  const size = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (size > settings.performance.maxDownloadBytes) add("(all)", "Game is over the download limit.");

  for (const file of files) {
    const pathCheck = safeGamePath(file.path);
    if (!pathCheck.ok) add(file.path, pathCheck.reason);
    if (HIDDEN.test(file.content.replace(/[\r\n\t]/g, " "))) add(file.path, "hidden characters");

    const isHtml = file.path.endsWith(".html") || file.path.endsWith(".svg");
    const isCode = isHtml || file.path.endsWith(".js");
    if (isCode) {
      for (const [pattern, problem] of BANNED) if (pattern.test(file.content)) add(file.path, problem);
    }
    if (isHtml) {
      for (const [pattern, problem] of BANNED_HTML) if (pattern.test(file.content)) add(file.path, problem);
    }
    if (file.path.endsWith(".js")) {
      if (BANNED_DOM_CREATION.test(file.content)) add(file.path, "creates an input field, link, or embedded page");
      if (BANNED_HTML_INJECTION.test(file.content)) add(file.path, "injects raw HTML");
    }
    if (file.path.endsWith(".css") && /@import|url\s*\(\s*['"]?(https?:|\/\/)/i.test(file.content)) {
      add(file.path, "loads an external stylesheet or image");
    }
  }
  return found;
}
