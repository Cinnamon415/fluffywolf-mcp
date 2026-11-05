#!/usr/bin/env node
// MCP server (stdio) + WebSocket bridge to the browser extension.
//
// Every server process is one agent: it gets a random id, listens on its own port from a small range and the
// extension connects to every port in that range. What the agent may do is decided by the extension, per window.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PORT = Number(process.env.FLUFFYWOLF_MCP_PORT || 8767);
const PORT_SPAN = 10; // keep in sync with `span` in build.mjs
const AGENT_ID = randomBytes(16).toString("hex");
const log = (...a) => console.error("[fluffywolf-mcp]", ...a);

// The shared secret the extension presents. First found wins: FLUFFYWOLF_MCP_TOKEN, the `.token` file that
// build.mjs writes for your own build, then the public `default.token` that the released extension is built with.
function loadToken() {
  const fromEnv = (process.env.FLUFFYWOLF_MCP_TOKEN || "").trim();
  const candidates = [["FLUFFYWOLF_MCP_TOKEN", () => fromEnv], [".token", () => readFileSync(join(root, ".token"), "utf8")], ["default.token", () => readFileSync(join(root, "default.token"), "utf8")]];
  for (const [source, read] of candidates) {
    let t = "";
    try { t = read().trim(); } catch {}
    if (!t) continue;
    if (t.length < 32) throw new Error(`The token from ${source} is too short (32 characters at least).`);
    return { token: t, source };
  }
  throw new Error("No token found: expected FLUFFYWOLF_MCP_TOKEN, .token or default.token next to the server.");
}
const { token: TOKEN, source: TOKEN_SOURCE } = loadToken();

// ---------------- bridge ----------------
//
// One extension connection per running browser profile. Profiles never see each other: the agent first lists the
// profiles, then asks for access in the ones it needs; the others are not even told who the agent is.

const profiles = new Map(); // profileId -> { id, label, ws, status }
let port = null;            // the port this process listens on
let nextId = 1;
const pending = new Map();  // call id -> { resolve, reject, timer, profileId }
const stateWaiters = new Set();
let noticeBuf = [];         // notices from the extensions, appended to the next tool result

const NOT_CONNECTED = "No browser profile is connected (the browser is not running, the 'FluffyWolf MCP' extension is disabled, or all bridge ports are busy). Ask the user to check it, then retry.";
const clean = (s, max) => String(s ?? "").replace(/[^\P{C}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

function tokenOk(given) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function failPending(profileId, reason) {
  for (const [id, p] of pending) {
    if (p.profileId !== profileId) continue;
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

function startBridge(p = BASE_PORT) {
  const http = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({
    server: http,
    // Web pages can open ws://127.0.0.1 too; only a browser extension has a moz-extension:// origin.
    verifyClient: ({ origin }) => typeof origin === "string" && origin.startsWith("moz-extension://"),
  });
  wss.on("error", () => {}); // server errors are handled below
  http.once("error", (e) => {
    if (e.code !== "EADDRINUSE") return log("bridge error:", e.message);
    if (p + 1 < BASE_PORT + PORT_SPAN) return startBridge(p + 1);
    log(`all bridge ports ${BASE_PORT}-${BASE_PORT + PORT_SPAN - 1} are busy; retrying in 5s`);
    setTimeout(() => startBridge(BASE_PORT), 5000);
  });
  http.listen(p, "127.0.0.1", () => {
    port = p;
    log(`agent ${AGENT_ID.slice(-4)}: bridge listening on 127.0.0.1:${p}`);
    if (TOKEN_SOURCE === "default.token") log("using the PUBLIC default token: build your own extension and set your own token (see README, Security model)");
  });

  wss.on("connection", (ws) => {
    let profile = null;
    const authTimer = setTimeout(() => !profile && ws.close(), 5000);
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!profile) {
        if (msg.type === "hello" && tokenOk(msg.token) && /^[0-9a-f]{32}$/.test(msg.profileId || "")) {
          clearTimeout(authTimer);
          const old = profiles.get(msg.profileId);
          profile = { id: msg.profileId, label: clean(msg.profile, 40) || `profile-${msg.profileId.slice(-4)}`, ws, status: null };
          profiles.set(profile.id, profile); // a reconnecting profile replaces its own old socket
          if (old && old.ws !== ws) old.ws.close();
          ws.send(JSON.stringify({ type: "agent", agentId: AGENT_ID }));
          log(`profile "${profile.label}" connected (extension v${msg.version})`);
        } else ws.close();
        return;
      }
      if (msg.type === "profile") { profile.label = clean(msg.label, 40) || profile.label; return; }
      if (msg.type === "state") {
        profile.status = msg.status;
        if (msg.status && (msg.status.state === "active" || msg.status.kicked)) { for (const w of stateWaiters) w(); stateWaiters.clear(); }
        return;
      }
      const p = pending.get(msg.id);
      if (!p || p.profileId !== profile.id) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (Array.isArray(msg.notices)) {
        const tag = profiles.size > 1 ? `[${profile.label}] ` : "";
        noticeBuf.push(...msg.notices.map((n) => tag + String(n)));
      }
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    });
    const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 20000);
    ws.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      if (profile && profiles.get(profile.id)?.ws === ws) {
        profiles.delete(profile.id);
        failPending(profile.id, `The browser profile "${profile.label}" disconnected.`);
        log(`profile "${profile.label}" disconnected`);
      }
    });
  });
}

function call(profile, cmd, args = {}, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, profileId: profile.id });
    profile.ws.send(JSON.stringify({ id, cmd, args }));
  });
}

const names = () => [...profiles.values()].map((p) => `"${p.label}"`).join(", ");

function findProfile(ref) {
  const r = String(ref).trim().toLowerCase();
  const hit = [...profiles.values()].filter((p) => p.id === r || (r.length >= 6 && p.id.startsWith(r)) || p.label.toLowerCase() === r);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw new Error(`Several profiles are called "${ref}"; use the id from list_profiles.`);
  throw new Error(`No connected profile "${ref}". Connected profiles: ${names() || "none"}.`);
}

// The profile a tool call goes to: the one named, else the only one where the agent has access.
function pick(ref) {
  if (!profiles.size) throw new Error(NOT_CONNECTED);
  if (ref) return findProfile(ref);
  const all = [...profiles.values()];
  const active = all.filter((p) => p.status && p.status.state === "active");
  if (active.length === 1) return active[0];
  if (active.length > 1) throw new Error(`You have access in several profiles (${active.map((p) => `"${p.label}"`).join(", ")}); pass profile.`);
  if (all.length === 1) return all[0]; // the extension explains what is missing
  const kicked = all.filter((p) => p.status && p.status.kicked);
  if (kicked.length) throw new Error(kicked.map((p) => `${p.label}: ${p.status.kicked}`).join("\n"));
  throw new Error(`You have no access in any profile yet. Running profiles: ${names()}. Call request_access with the profiles you need.`);
}

const rcall = ({ profile, ...args }, cmd, timeoutMs) => call(pick(profile), cmd, args, timeoutMs);

// Resolves when any profile reports "active", or after `ms`.
function waitForActive(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); stateWaiters.delete(done); resolve(); };
    const t = setTimeout(done, ms);
    stateWaiters.add(done);
  });
}

// ---------------- tools ----------------

const INSTRUCTIONS = [
  "Browser access is gated by the user and separate for every browser profile. First call list_profiles, then request_access",
  "with a short name of your own, what you want to do and the profiles you need; the user then picks this session in the",
  "FluffyWolf MCP popup of the window you should use. You only see the tabs the user allowed (unless they gave you full access).",
  "If you have access in several profiles, pass `profile` to every tool. Replies may end with '[FluffyWolf notices]': changes of",
  "your rights or of the page state made by the user. Read them before continuing.",
].join(" ");

const server = new McpServer({ name: "fluffywolf", version: "1.3.0" }, { instructions: INSTRUCTIONS });

const tabId = z.number().int().optional().describe("Tab id from list_tabs. Defaults to the tab you used last.");
const ref = z.string().optional().describe("Element ref from snapshot, e.g. e12");
const selector = z.string().optional().describe("CSS selector (alternative to ref)");

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });
// Notices from the extension (rights changed, the user closed or moved a tab, ...) ride along with the next result.
function withNotices(res) {
  if (!noticeBuf.length) return res;
  const t = "\n\n[FluffyWolf notices: the user changed something, read before continuing]\n" + noticeBuf.map((n) => `- ${n}`).join("\n");
  noticeBuf = [];
  res.content.push({ type: "text", text: t });
  return res;
}
const profile = z.string().optional().describe("Profile name or id from list_profiles. Needed only when you have access in more than one profile.");
// Every tool that acts on a browser takes `profile`; the ones that manage access say routed=false.
const tool = (name, description, schema, fn, routed = true) =>
  server.registerTool(name, { description, inputSchema: routed ? { ...schema, profile } : schema }, async (args) => {
    try { return withNotices(await fn(args)); } catch (e) { return withNotices(fail(e)); }
  });

tool("list_tabs", "List the browser tabs you can use (id, window, title, url, active, own). Tabs the user has not allowed are not shown. With access in several profiles and no `profile`, tabs of all of them are listed, each marked with its profile.", {},
  async (a) => {
    const active = [...profiles.values()].filter((p) => p.status && p.status.state === "active");
    if (!a.profile && active.length > 1) {
      const out = [];
      for (const p of active) out.push(...(await call(p, "list_tabs")).map((t) => ({ profile: p.label, ...t })));
      return text(out);
    }
    return text(await rcall(a, "list_tabs"));
  });

tool("open_tab", "Open a URL in a new tab of a shared window and wait for it to load. Needs the 'open new tabs' right. The tab stays yours: you may close it later.", { url: z.string(), active: z.boolean().optional().describe("Focus the new tab (default true)"), windowId: z.number().int().optional().describe("Shared window to use; default is the window of your current tab") },
  async (a) => text(await rcall(a, "open_tab")));

tool("close_tab", "Close a tab. Without full access only tabs you opened yourself can be closed.", { tabId }, async (a) => text(await rcall(a, "close_tab")));

tool("activate_tab", "Bring a tab (and its window) to the front.", { tabId }, async (a) => text(await rcall(a, "activate_tab")));

tool("navigate", "Navigate a tab to a URL and wait for it to load.", { url: z.string(), tabId }, async (a) => text(await rcall(a, "navigate")));

tool("history", "Go back, forward or reload in a tab.", { action: z.enum(["back", "forward", "reload"]), tabId }, async (a) => text(await rcall(a, "history")));

tool("snapshot", "Accessibility-style outline of the page with [ref=eN] handles for interactive elements. Prefer this over screenshot for reading and for choosing click/type targets. Refs are valid until the page reloads.",
  { tabId, maxChars: z.number().int().positive().optional().describe("Output cap, default 30000") },
  async (a) => {
    const r = await rcall(a, "snapshot");
    const head = `${r.title}\n${r.url}\nscroll ${r.scroll.y}/${r.scroll.pageHeight} (viewport ${r.scroll.viewportHeight})${r.truncated ? "  [truncated]" : ""}\n\n`;
    return text(head + r.tree);
  });

tool("get_text", "Plain visible text of the page or of one element.", { tabId, selector, maxChars: z.number().int().positive().optional().describe("Default 20000") },
  async (a) => {
    const r = await rcall(a, "get_text");
    return text(`${r.title}\n${r.url}${r.truncated ? "\n[truncated]" : ""}\n\n${r.text}`);
  });

tool("click", "Click an element by ref, CSS selector or viewport coordinates (synthetic DOM events).",
  { tabId, ref, selector, x: z.number().optional(), y: z.number().optional(), double: z.boolean().optional() },
  async (a) => text(await rcall(a, "click")));

tool("type_text", "Type into an input/textarea/contenteditable (ref, selector, or the focused element). Appends unless clear=true. submit=true presses Enter afterwards.",
  { tabId, ref, selector, text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional() },
  async (a) => text(await rcall(a, "type_text")));

tool("press_key", "Press a key, e.g. Enter, Tab, Escape, ArrowDown, Control+a, Shift+Tab, on the focused element or a ref.",
  { tabId, key: z.string(), ref },
  async (a) => text(await rcall(a, "press_key")));

tool("scroll", "Scroll the page: by dx/dy pixels, to 'top'/'bottom', or an element into view (ref).",
  { tabId, dx: z.number().optional(), dy: z.number().optional(), to: z.enum(["top", "bottom"]).optional(), ref },
  async (a) => text(await rcall(a, "scroll")));

tool("evaluate", "Run JavaScript in the page. `code` is an expression, or a function body using `return`. Awaits promises. Runs in the page's own world by default (falls back to the extension's isolated world if the page CSP blocks eval). Result is JSON.",
  { tabId, code: z.string(), world: z.enum(["page", "isolated"]).optional() },
  async (a) => {
    const r = await rcall(a, "evaluate", 45000);
    return text(`[${r.world} world]\n${r.value}`);
  });

tool("screenshot", "PNG screenshot of the visible area of a tab (works for background tabs too).", { tabId },
  async (a) => {
    const { dataUrl } = await rcall(a, "screenshot");
    return { content: [{ type: "image", data: dataUrl.replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" }] };
  });

tool("list_profiles", "List the browser profiles that are running with the extension. Profiles are isolated from each other and from you until you ask one of them for access. Call this first, then request_access with the profiles you need.", {},
  async () => {
    if (!profiles.size) throw new Error(NOT_CONNECTED);
    return text([...profiles.values()].map((p) => ({ profile: p.label, id: p.id, yourState: p.status ? p.status.state : "not requested" })));
  }, false);

tool("request_access", "Identify yourself and ask the user for access in one or more browser profiles (names from list_profiles). Give a short name of your own and what you want to do; the user picks this session in the FluffyWolf MCP popup of the window you should use, in each profile you named. Waits up to a minute for an answer. Pass `resume` (ids you received earlier) after a reconnect to get your saved tab lists back.",
  { name: z.string().min(1).max(40), purpose: z.string().max(160).optional(), profiles: z.array(z.string()).max(10).optional().describe("Profile names or ids. May be omitted only when a single profile is running."), resume: z.array(z.string()).max(10).optional() },
  async (a) => {
    if (!profiles.size) throw new Error(NOT_CONNECTED);
    let chosen;
    if (a.profiles && a.profiles.length) chosen = [...new Set(a.profiles.map(findProfile))];
    else if (profiles.size === 1) chosen = [...profiles.values()];
    else throw new Error(`Several profiles are running (${names()}). Pass profiles: one or more names from list_profiles.`);
    // cwd and pid come from this process, never from the model, so the user can trust them.
    const ask = { name: a.name, purpose: a.purpose, resume: a.resume, cwd: process.cwd(), pid: process.pid };
    await Promise.all(chosen.map(async (p) => { p.status = await call(p, "request_access", ask); }));
    if (!chosen.some((p) => p.status.state === "active")) await waitForActive(55000);
    return text(chosen.map((p) => {
      const s = p.status;
      if (s.kicked) return `${p.label}: ${s.kicked}`;
      if (s.state === "active") {
        const wins = s.windows.filter((w) => w.active).map((w) => `${w.windowId} (${Math.ceil(w.secondsLeft / 60)} min left)`).join(", ");
        return `${p.label}: access granted to window(s) ${wins}.\n  ${s.rights}`;
      }
      return `${p.label}: not granted yet. The user has to click the FluffyWolf MCP button in the toolbar of the window you should work in, press the plank and pick "${s.name}" (${s.label}).`;
    }).join("\n") + (chosen.some((p) => p.status.state !== "active") ? "\nCall request_access again to keep waiting." : ""));
  }, false);

tool("status", "Your connection and access in every running profile: state (unbound, active, paused), shared windows with time left, and your rights.", {},
  async () => {
    const out = [];
    for (const p of profiles.values()) out.push({ profile: p.label, id: p.id, ...(await call(p, "status")) });
    return text({ extensionConnected: profiles.size > 0, port, profiles: out });
  }, false);

startBridge();
await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");
