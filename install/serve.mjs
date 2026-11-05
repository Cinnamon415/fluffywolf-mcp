// Serves the install page and the .xpi on 127.0.0.1 only. Stop it with Ctrl+C once the extension is installed.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8799);
const files = {
  "/": [join(here, "index.html"), "text/html; charset=utf-8"],
  "/fluffywolf-mcp.xpi": [join(here, "..", "dist", "fluffywolf-mcp.xpi"), "application/x-xpinstall"],
};

createServer(async (req, res) => {
  const entry = files[new URL(req.url, "http://x").pathname];
  console.log(new Date().toISOString(), req.method, req.url, entry ? 200 : 404);
  if (!entry) return res.writeHead(404).end("not found");
  try {
    res.writeHead(200, { "content-type": entry[1], "cache-control": "no-store" }).end(await readFile(entry[0]));
  } catch {
    res.writeHead(500).end("missing file (run node build.mjs)");
  }
}).listen(port, "127.0.0.1", () => console.log(`install page: http://127.0.0.1:${port}/`));
