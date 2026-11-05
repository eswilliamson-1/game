import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { GameFile } from "./safety.ts";

export function readGame(dir: string): GameFile[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);
      return { path: relative(dir, full).replaceAll("\\", "/"), content: readFileSync(full, "utf8") };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function writeGame(dir: string, files: GameFile[]): void {
  for (const file of files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
  }
}

/** Short description of the game for the AI, without sending all of its code. */
export function describeGame(files: GameFile[]): string {
  if (files.some((f) => f.content.includes("data-placeholder"))) {
    return "The game hasn't started. There is only a placeholder page.";
  }
  return files.map((f) => `--- ${f.path}\n${f.content}`).join("\n");
}
