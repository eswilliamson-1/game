// Needs a preview build: npm run shell:build
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { serve } from "../../pipeline/serve.ts";

const PORT = 4175;
const URL = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SCREENSHOT_DIR;

let server: Server;
let browser: Browser;

before(async () => {
  server = await serve("dist/shell", PORT);
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  server.close();
});

async function open(path: string, width = 1280, height = 800) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text());
  });
  await page.goto(URL + path);
  return { page, errors };
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

const logIn = async (page: Page) => {
  await page.fill("#username", "dragon_fan");
  await page.fill("#password", "test-password");
  await page.check("#age");
  await page.click("text=Create account");
  await page.waitForSelector("text=Log out");
};

test("the review link only appears for the owner", async () => {
  const { page, errors } = await open("/");
  await page.waitForSelector("#board");
  assert.equal(await page.locator('#account a[href="review.html"]').count(), 0);
  await logIn(page);
  await page.waitForSelector('#account a[href="review.html"]');
  assert.deepEqual(errors, []);
});

test("logged-out players see the board, but can't vote", async () => {
  const { page, errors } = await open("/");
  await page.waitForSelector("#board");
  assert.equal(await page.locator(".option").first().isDisabled(), true);
  assert.equal(await page.locator("text=Change nothing this round").count(), 1);
  assert.equal(await page.locator(".option").nth(0).locator("text=Suggested by the AI").count(), 1);
  assert.deepEqual(errors, []);
  await shot(page, "home-desktop");
});

test("the board shows each idea's size and upvote target", async () => {
  const { page, errors } = await open("/");
  await page.waitForSelector("#board");
  assert.equal(await page.locator("text=Small change").count(), 1);
  assert.equal(await page.locator("text=Medium change: has its 2 upvotes").count(), 1);
  assert.equal(await page.locator("text=Major change: 1 of 3 upvotes needed").count(), 1);
  assert.deepEqual(errors, []);
});

test("the owner can enter their balance and see an estimate of what's left", async () => {
  const { page, errors } = await open("/review.html");
  await logIn(page);
  await page.waitForSelector("#spending >> text=Enter your balance");
  await page.fill("#credit", "50");
  await page.click("text=Update my balance");
  await page.waitForSelector("#spending >> text=About $48.75 left");
  assert.deepEqual(errors, []);
});

test("the owner can change an idea's size", async () => {
  const { page, errors } = await open("/review.html");
  await logIn(page);
  await page.waitForSelector("text=Idea sizes");
  await page.locator("text=Make medium").first().click();
  await page.waitForSelector("text=A tiny tower climber: Medium change");
  assert.deepEqual(errors, []);
});

test("a logged-in player can upvote several ideas and take a vote back", async () => {
  const { page, errors } = await open("/");
  await logIn(page);
  await page.locator(".option").nth(0).click();
  await page.waitForSelector('.option[aria-pressed="true"]');
  await page.locator(".option").nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.option[aria-pressed="true"]').length === 2);
  await page.locator('.option[aria-pressed="true"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.option[aria-pressed="true"]').length === 1);
  assert.deepEqual(errors, []);
});

test("a logged-in player suggests a change under their username", async () => {
  const { page, errors } = await open("/");
  await logIn(page);
  await page.waitForSelector("#account >> text=dragon_fan");
  assert.equal(await page.locator("#display-name").count(), 0);
  await page.fill("#proposal", "Add a pet dragon");
  await page.click("text=Submit");
  await page.waitForSelector("text=checked against the rules");
  assert.deepEqual(errors, []);
});

test("the suggestions page lists every suggestion with its status", async () => {
  const { page, errors } = await open("/suggestions.html");
  await page.waitForSelector("text=being checked");
  assert.equal(await page.locator("#suggestions .note").count(), 3);
  assert.equal(await page.locator("text=by dragon_fan").count(), 1);
  assert.equal(await page.locator("text=on the board").count(), 1);
  assert.deepEqual(errors, []);
  await shot(page, "suggestions");
});

test("the board shows a live countdown", async () => {
  const page = await browser.newPage();
  await page.clock.install();
  await page.goto(URL);
  await page.waitForSelector("#ballot-time");
  const read = () => page.locator("#ballot-time").innerText();
  assert.match(await read(), /^Round ends in 2[12]:\d\d$/);
  const before = await read();
  await page.clock.fastForward(5_000);
  assert.notEqual(await read(), before);
  await page.clock.fastForward(23 * 60_000);
  assert.match(await read(), /ending now/);
});

test("every page says when a change is building", async () => {
  for (const path of ["/?building", "/suggestions.html?building", "/rules.html?building"]) {
    const { page, errors } = await open(path);
    await page.waitForSelector("#build-status >> text=Building now: A tiny tower climber");
    assert.deepEqual(errors, []);
  }
  const { page } = await open("/");
  await page.waitForSelector("#board");
  assert.equal(await page.locator("#build-status").isVisible(), false);
});

test("during a build, the board says the round waits for it", async () => {
  const { page, errors } = await open("/?building");
  await page.waitForSelector("#ballot-time >> text=This round ends once the current build finishes");
  await page.waitForSelector("#build-status >> text=Running for 12 min");
  assert.deepEqual(errors, []);
});

test("the winning idea stays on the board while it builds", async () => {
  const { page, errors } = await open("/?building");
  await page.waitForSelector("#board >> text=Won, and being built now");
  assert.equal(await page.locator(".option").first().isDisabled(), true);
  assert.deepEqual(errors, []);
});

test("the banner names the build stage", async () => {
  for (const [stage, words] of [["writing", "Step 1 of 3"], ["testing", "Step 2 of 3"], ["fixing", "trying to fix it"], ["publishing", "Step 3 of 3"]]) {
    const { page, errors } = await open(`/?building=${stage}`);
    await page.waitForSelector(`#build-status >> text=${words}`);
    assert.deepEqual(errors, []);
  }
});

test("when a build finishes, the banner updates and the game reloads by itself", async () => {
  const page = await browser.newPage();
  await page.clock.install();
  await page.goto(`${URL}/?building=once`);
  await page.waitForSelector("text=Building now");
  await page.waitForSelector("iframe.game");
  await page.evaluate(() => ((window.frames[0] as any).marked = true));
  await page.clock.fastForward(15_000);
  await page.waitForSelector("#build-status >> text=The build has finished");
  await page.waitForFunction(() => !(window.frames[0] as any).marked);
  await page.clock.fastForward(15_000);
  assert.equal(await page.locator("#build-status >> text=The build has finished").count(), 1);
});

test("the page updates by itself without wiping a draft", async () => {
  const page = await browser.newPage();
  await page.clock.install();
  await page.goto(URL);
  await logIn(page);
  await page.fill("#proposal", "A half-typed idea");
  await page.focus("#proposal");
  await page.evaluate(() => document.querySelector("#leaderboard")!.setAttribute("data-old", "yes"));
  await page.clock.fastForward(15_000);
  await page.waitForFunction(() => !document.querySelector("#leaderboard")!.hasAttribute("data-old"));
  assert.equal(await page.inputValue("#proposal"), "A half-typed idea");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "proposal");
});

test("patch notes show credit and past versions", async () => {
  const { page, errors } = await open("/patch-notes.html");
  await page.waitForSelector(".note");
  assert.equal(await page.locator("text=Suggested by Dragon Fan").count(), 1);
  assert.equal(await page.locator("text=Play this version").count(), 2);
  assert.deepEqual(errors, []);
  await shot(page, "patch-notes");
});

test("creating an account asks for no email, and needs the age check", async () => {
  const { page, errors } = await open("/");
  await page.waitForSelector("#username");
  assert.equal(await page.locator('input[type="email"]').count(), 0);
  await page.fill("#username", "dragon_fan");
  await page.fill("#password", "test-password");
  await page.click("text=Create account");
  await page.waitForSelector("text=confirm you're 16 or older");
  assert.equal(await page.locator("text=Log out").count(), 0);
  await logIn(page);
  assert.deepEqual(errors, []);
});

test("returning players log in without the age check, and can log out", async () => {
  const { page, errors } = await open("/");
  await page.fill("#username", "dragon_fan");
  await page.fill("#password", "test-password");
  await page.click("button.secondary:text-is('Log in')");
  await page.waitForSelector("text=Log out");
  await page.click("text=Log out");
  await page.waitForSelector("#username");
  assert.deepEqual(errors, []);
});

test("joined players see their progress, and everyone sees the leaderboard", async () => {
  const { page, errors } = await open("/");
  await page.waitForSelector("#leaderboard >> text=Dragon Fan");
  assert.equal(await page.locator("#progress").count(), 0);
  await logIn(page);
  await page.waitForSelector("#progress >> text=Regular · 10 points");
  assert.equal(await page.locator("#progress .badge").count(), 3);
  await page.locator(".option").first().click();
  await page.waitForSelector("#progress >> text=11 points");
  assert.deepEqual(errors, []);
  await shot(page, "progress");
});

test("a player can download and delete their data", async () => {
  const { page, errors } = await open("/");
  await logIn(page);
  await page.click("#account >> text=Your data");
  await page.waitForSelector("text=Download my data");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("text=Download my data")]);
  assert.equal(download.suggestedFilename(), "my-game-data.json");
  page.on("dialog", (dialog) => dialog.accept());
  await page.click("text=Delete my account");
  await page.waitForSelector("text=Log in to download or delete");
  assert.deepEqual(errors, []);
  await shot(page, "privacy");
});

test("the rules page lists all 17 rules and is linked from every page", async () => {
  const { page } = await open("/rules.html");
  assert.equal(await page.locator(".rules li").count(), 17);
  await shot(page, "rules");
  for (const path of ["/", "/suggestions.html", "/patch-notes.html", "/review.html", "/privacy.html"]) {
    const other = await open(path);
    assert.equal(await other.page.locator('nav a[href="rules.html"]').count(), 1);
    assert.equal(await other.page.locator('nav a[href="privacy.html"]').count(), 1);
  }
});

test("the game runs in a sandboxed frame", async () => {
  const { page } = await open("/");
  const sandbox = await page.locator("iframe.game").getAttribute("sandbox");
  assert.equal(sandbox, "allow-scripts allow-same-origin");
});

test("the review page needs a login, then shows the queue", async () => {
  const { page, errors } = await open("/review.html");
  await page.waitForSelector("#username");
  await logIn(page);
  await page.waitForSelector("text=Ideas waiting for approval");
  assert.equal(await page.locator("text=Pause the game").count(), 1);
  assert.deepEqual(errors, []);
  await shot(page, "review");
});

test("no page scrolls sideways at phone width", async () => {
  for (const path of ["/", "/suggestions.html", "/patch-notes.html", "/rules.html", "/review.html", "/privacy.html"]) {
    const { page } = await open(path, 375, 812);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `${path} overflows by ${overflow}px`);
    if (path === "/") await shot(page, "home-phone");
  }
});
