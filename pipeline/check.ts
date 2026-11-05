// Runs in GitHub Actions with no secrets at all, because this is the only step
// that executes generated code.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type CDPSession, type Page } from "playwright";
import settings from "../config/settings.json" with { type: "json" };
import { readGame } from "./lib/files.ts";
import { scanFiles } from "./lib/safety.ts";
import { serve } from "./serve.ts";

// Same policy the live host sends, so the test sees what players will get.
export const GAME_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts allow-same-origin";

const FPS_TOLERANCE = 0.9;
const PORT = 4174;

export type CheckResult = { ok: boolean; failures: string[]; metrics: Record<string, number> };

type Device = { name: "phone" | "laptop"; cpuSlowdown: number; slowNetwork: boolean; minFps: number };

const DEVICES: Device[] = [
  { name: "phone", cpuSlowdown: 4, slowNetwork: true, minFps: settings.performance.minFpsPhone },
  { name: "laptop", cpuSlowdown: 1, slowNetwork: false, minFps: settings.performance.minFpsLaptop },
];

async function press(page: Page) {
  const box = page.viewportSize()!;
  await page.mouse.click(box.width / 2, box.height / 2);
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Space", "Enter"]) {
    await page.keyboard.press(key);
  }
  for (const button of await page.locator("button:visible").all()) {
    await button.click({ timeout: 500 }).catch(() => {});
  }
}

async function measureFps(page: Page, ms: number): Promise<number> {
  return page.evaluate(
    (duration) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const step = (now: number) => {
          frames++;
          if (now - start < duration) requestAnimationFrame(step);
          else resolve((frames * 1000) / (now - start));
        };
        requestAnimationFrame(step);
      }),
    ms,
  );
}

async function heapBytes(cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
}

async function testDevice(url: string, device: Device, seconds: number, result: CheckResult) {
  const fail = (problem: string) => result.failures.push(`${device.name}: ${problem}`);
  const perf = settings.performance;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: device.cpuSlowdown });
    if (device.slowNetwork) {
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
    }

    let bytes = 0;
    page.on("pageerror", (error) => fail(`script error: ${error.message}`));
    page.on("crash", () => fail("the page crashed"));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("favicon")) fail(`console error: ${message.text()}`);
    });
    page.on("response", async (response) => {
      bytes += (await response.body().catch(() => Buffer.alloc(0))).length;
    });
    await page.route("**/*", (route) => {
      if (route.request().url().startsWith(url)) return route.continue();
      fail(`tried to reach ${route.request().url()}`);
      return route.abort();
    });

    const loadStart = Date.now();
    await page.goto(url);
    const ready = await page
      .waitForFunction(() => typeof (window as any).gameTest === "object", undefined, { timeout: 15_000 })
      .then(() => true, () => false);
    const loadMs = Date.now() - loadStart;
    result.metrics[`${device.name}LoadMs`] = loadMs;
    if (!ready) {
      fail("the game never started (window.gameTest is missing)");
      return;
    }
    if (loadMs > perf.maxLoadMs) fail(`took ${loadMs} ms to load (limit ${perf.maxLoadMs})`);
    if (bytes > perf.maxDownloadBytes) fail(`downloaded ${bytes} bytes (limit ${perf.maxDownloadBytes})`);

    const goal = await page.evaluate(() => String((window as any).gameTest.goal ?? "").trim());
    if (!goal) fail("the game has no goal");
    else if (!(await page.getByText(goal, { exact: false }).first().isVisible().catch(() => false))) {
      fail("the goal isn't visible on screen");
    }

    await page.evaluate(() => {
      const delays: number[] = ((window as any).__inputDelays = []);
      addEventListener(
        "pointerdown",
        (event) => requestAnimationFrame(() => delays.push(performance.now() - event.timeStamp)),
        true,
      );
    });

    const handled = () => page.evaluate(() => Number((window as any).gameTest.inputsHandled) || 0);
    const before = await handled();
    await press(page);
    if ((await handled()) <= before) fail("the game didn't respond to player input");

    const startHeap = await heapBytes(cdp);
    const end = Date.now() + seconds * 1000;
    const fpsSamples: number[] = [];
    while (Date.now() < end && !page.isClosed()) {
      await press(page);
      fpsSamples.push(await measureFps(page, 1000));
    }
    const fps = fpsSamples.reduce((a, b) => a + b, 0) / Math.max(fpsSamples.length, 1);
    result.metrics[`${device.name}Fps`] = Math.round(fps);
    if (fps < device.minFps * FPS_TOLERANCE) fail(`ran at ${Math.round(fps)} FPS (limit ${device.minFps})`);

    const delays = await page.evaluate(() => (window as any).__inputDelays as number[]);
    const worst = Math.max(0, ...delays.sort((a, b) => a - b).slice(0, Math.ceil(delays.length * 0.95)));
    result.metrics[`${device.name}InputMs`] = Math.round(worst);
    if (worst > perf.maxInputMs) fail(`took ${Math.round(worst)} ms to respond to input (limit ${perf.maxInputMs})`);

    const endHeap = await heapBytes(cdp);
    result.metrics[`${device.name}HeapGrowth`] = Number((endHeap / Math.max(startHeap, 1)).toFixed(2));
    if (endHeap > startHeap * perf.maxHeapGrowthRatio && endHeap - startHeap > 5 * 1024 * 1024) {
      fail(`memory grew from ${startHeap} to ${endHeap} bytes`);
    }
  } finally {
    await browser.close();
  }
}

export async function checkGame(dir: string, seconds = settings.performance.playSessionSeconds): Promise<CheckResult> {
  const result: CheckResult = { ok: false, failures: [], metrics: {} };
  for (const v of scanFiles(readGame(dir))) result.failures.push(`scan: ${v.path}: ${v.problem}`);
  if (result.failures.length === 0) {
    const server = await serve(dir, PORT, { "Content-Security-Policy": GAME_CSP });
    try {
      for (const device of DEVICES) await testDevice(`http://127.0.0.1:${PORT}/`, device, seconds, result);
    } finally {
      server.close();
    }
  }
  result.ok = result.failures.length === 0;
  return result;
}

async function main() {
  const outcomeFile = ".candidate/outcome.json";
  const outcome = existsSync(outcomeFile) ? JSON.parse(readFileSync(outcomeFile, "utf8")) : { ok: false, reason: "No build output." };
  const result: CheckResult = outcome.ok
    ? await checkGame(".candidate/game")
    : { ok: false, failures: [outcome.reason], metrics: {} };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync("failure.txt", result.failures.join("\n"));
  writeFileSync(process.env.GITHUB_OUTPUT ?? "check-output.txt", `passed=${result.ok}\n`, { flag: "a" });
}

if (process.argv[1]?.endsWith("check.ts")) await main();
