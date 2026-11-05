import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Static server for local previews and play tests. */
export function serve(dir: string, port: number, headers: Record<string, string> = {}): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = join(dir, normalize(decodeURIComponent(url.pathname)));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", ...headers });
    createReadStream(path).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1]?.endsWith("serve.ts")) {
  const [dir, port] = process.argv.slice(2);
  await serve(dir, Number(port));
  console.log(`Serving ${dir} at http://127.0.0.1:${port}`);
}
