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

// The shared secret the extension presents: the `.token` that build.mjs generated for your own build, otherwise the
// public `default.token` that the released extension is built with.
function loadToken() {
  for (const file of [".token", "default.token"]) {
    let t = "";
    try { t = readFileSync(join(root, file), "utf8").trim(); } catch {}
    if (t.length >= 32) return { token: t, source: file };
  }
  throw new Error("No token found: expected .token or default.token next to the server.");
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
const profileWaiters = new Set(); // resolved when a profile connects
const STARTED = Date.now();
let noticeBuf = [];         // notices from the extensions, appended to the next tool result

const NOT_CONNECTED = "No browser profile is connected (the browser is not running, the 'FluffyWolf MCP' extension is disabled, or all bridge ports are busy). If this server has only just started, wait a few seconds and retry: the browser finds a new server within about four seconds. Otherwise ask the user to check it.";
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
          for (const w of profileWaiters) w();
          profileWaiters.clear();
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

// A server that has just started is usually found by the browser within a few seconds. Until then the first calls wait
// a little instead of reporting that no browser is connected, which agents take as "the browser is not running".
async function waitForFirstProfile() {
  if (profiles.size || Date.now() - STARTED > 30000) return;
  await new Promise((resolve) => {
    const done = () => { clearTimeout(t); profileWaiters.delete(done); resolve(); };
    const t = setTimeout(done, 8000);
    profileWaiters.add(done);
  });
}

// Resolves when any profile reports "active", or after `ms`.
function waitForActive(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); stateWaiters.delete(done); resolve(); };
    const t = setTimeout(done, ms);
    stateWaiters.add(done);
  });
}

// ---------------- tools ----------------

// The same guide is delivered three ways, because clients differ: as the server instructions, in the first reply of
// list_profiles, and in the description of the tools an agent meets first.
const GUIDE = [
  "How to use FluffyWolf MCP: it gives you the user's real browser, but only what the user allows.",
  "1. list_profiles shows the running browser profiles. Start here.",
  "2. request_access: give a short name, what you want to do and the profiles to ask (several is fine; if unsure, ask all of them).",
  "The user picks you in the FluffyWolf popup of the window you should use. This can take up to a minute: if it says 'not granted yet',",
  "call request_access again. One profile is enough, you do not have to wait for the others.",
  "3. list_tabs lists only the tabs the user shared with the address-bar button. If it is empty, ask the user to click that button on the",
  "tab you should use (or use open_tab if you have the 'open new tabs' right), then call list_tabs again.",
  "4. Work with the tab: screenshot (image of the visible area), snapshot or get_text (read the page), click, type_text, press_key,",
  "scroll, navigate, evaluate. Pass tabId from list_tabs, and `profile` if you have access in several profiles.",
  "Replies may end with '[FluffyWolf notices]': things the user changed, or changes of your rights. Read them before continuing.",
  "The user can pause or end your access at any time; the error then says how to ask again.",
].join("\n");
const INSTRUCTIONS = GUIDE;

const server = new McpServer({ name: "fluffywolf", version: "1.3.2" }, { instructions: INSTRUCTIONS });

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
    try { await waitForFirstProfile(); return withNotices(await fn(args)); } catch (e) { return withNotices(fail(e)); }
  });

tool("list_tabs", "List the browser tabs you can use (id, window, title, url, active, own). Tabs the user has not allowed are not shown. With access in several profiles and no `profile`, tabs of all of them are listed, each marked with its profile.", {},
  async (a) => {
    const active = [...profiles.values()].filter((p) => p.status && p.status.state === "active");
    if (!a.profile && active.length > 1) {
      const out = [];
      for (const p of active) out.push(...(await call(p, "list_tabs")).map((t) => ({ profile: p.label, ...t })));
      return text(out);
    }
    const tabs = await rcall(a, "list_tabs");
    if (Array.isArray(tabs) && !tabs.length) return text(`[]\nNo tab is shared with you yet. Ask the user to click the FluffyWolf MCP button in the address bar of the tab you should use (or use open_tab if you have the 'open new tabs' right), then call list_tabs again.`);
    return text(tabs);
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

let guideShown = false;
tool("list_profiles", "START HERE for anything in the user's browser (screenshot, reading a page, clicking). Lists the running browser profiles. Then call request_access with the profiles you need, then list_tabs, then the tool you want (e.g. screenshot).", {},
  async () => {
    if (!profiles.size) throw new Error(NOT_CONNECTED);
    const res = text([...profiles.values()].map((p) => ({ profile: p.label, id: p.id, yourState: p.status ? p.status.state : "not requested" })));
    if (!guideShown) { guideShown = true; res.content.push({ type: "text", text: `[FluffyWolf guide]\n${GUIDE}` }); }
    return res;
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
    }).join("\n") + (chosen.some((p) => p.status.state === "active")
      ? "\nNext: call list_tabs to see the tabs you may use, then the tool you need (for a picture of a page: screenshot)."
        + (chosen.some((p) => p.status.state !== "active") ? " Profiles that are 'not granted yet' can be ignored; call request_access again only if you need them." : "")
      : "\nThe user has not picked you yet. Call request_access again to keep waiting."));
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
