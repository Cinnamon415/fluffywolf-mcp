// Starts two real MCP server processes (two agents) and plays the extension's side for two browser profiles over
// real WebSockets. Checks profile discovery, isolation, routing and what happens when one profile goes away.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "server", "index.mjs"));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const WebSocket = require("ws");

const BASE = 18767;
// the servers under test look for .token, then default.token: so do the fake profiles
const fileToken = (f) => { try { return readFileSync(join(root, f), "utf8").trim(); } catch { return ""; } };
const token = [fileToken(".token"), fileToken("default.token")].find((t) => t.length >= 32);

async function startAgent() {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({
    command: "node", args: [join(root, "server", "index.mjs")],
    env: { ...process.env, FLUFFYWOLF_MCP_PORT: String(BASE) }, stderr: "ignore",
  }));
  return client;
}
const text = (r) => r.content.map((c) => c.text ?? `<${c.type}>`).join("\n");
const firstBlock = (r) => r.content[0].text; // list_profiles puts the guide in a second block on its first call
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake browser profile: one socket per server port, like the real extension.
class Profile {
  constructor(label, behaviour) {
    this.id = randomBytes(16).toString("hex");
    this.label = label;
    this.behaviour = behaviour;
    this.conns = new Map(); // agentId -> ws
    this.sockets = new Map(); // port -> ws
    this.log = [];          // [agentId, cmd, args]
  }
  scan() {
    for (let p = BASE; p < BASE + 10; p++) {
      if (this.sockets.has(p)) continue;
      const ws = new WebSocket(`ws://127.0.0.1:${p}/`, { origin: "moz-extension://" + this.label });
      this.sockets.set(p, ws);
      ws.on("error", () => {});
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, version: "t", profileId: this.id, profile: this.label })));
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === "agent") { this.conns.set(msg.agentId, ws); ws.agentId = msg.agentId; return; }
        this.log.push([ws.agentId, msg.cmd, msg.args]);
        this.behaviour[msg.cmd]?.(this, ws, msg);
      });
      ws.on("close", () => { this.sockets.delete(p); if (ws.agentId) this.conns.delete(ws.agentId); });
    }
  }
  reply(ws, msg, body) { ws.send(JSON.stringify({ id: msg.id, ...body })); }
  push(ws, status) { ws.send(JSON.stringify({ type: "state", status })); }
  status(state, name) {
    return { state, name, label: "#x", windows: state === "active" ? [{ windowId: 1, active: true, secondsLeft: 900 }] : [], rights: `RESTRICTED (${this.label})` };
  }
  stop() { for (const ws of this.sockets.values()) ws.close(); }
  got(cmd) { return this.log.filter((l) => l[1] === cmd); }
}

// "work" answers at once and grants after a moment; "home" grants straight away.
const work = new Profile("work", {
  request_access: (p, ws, m) => {
    p.granted ??= new Set();
    if (p.granted.has(ws.agentId)) return p.reply(ws, m, { ok: true, result: p.status("active", m.args.name) });
    p.reply(ws, m, { ok: true, result: p.status("unbound", m.args.name) });
    setTimeout(() => { p.granted.add(ws.agentId); p.push(ws, p.status("active", m.args.name)); }, 300); // the user picks the agent
  },
  list_tabs: (p, ws, m) => p.reply(ws, m, { ok: true, result: [{ id: 1, title: "work tab" }], notices: ["tab 1 was navigated by the user"] }),
  status: (p, ws, m) => p.reply(ws, m, { ok: true, result: p.status("active", "x") }),
  evaluate: (p, ws) => ws.close(), // never answers
  snapshot: (p, ws, m) => p.reply(ws, m, { ok: true, result: { title: "t", url: "u", scroll: { y: 0, pageHeight: 1, viewportHeight: 1 }, tree: "work tree" } }),
});
const home = new Profile("home", {
  request_access: (p, ws, m) => p.reply(ws, m, { ok: true, result: p.status("active", m.args.name) }),
  list_tabs: (p, ws, m) => p.reply(ws, m, { ok: true, result: [{ id: 1, title: "home tab" }] }),
  status: (p, ws, m) => p.reply(ws, m, { ok: true, result: p.status("active", "x") }),
  snapshot: (p, ws, m) => p.reply(ws, m, { ok: true, result: { title: "t", url: "u", scroll: { y: 0, pageHeight: 1, viewportHeight: 1 }, tree: "home tree" } }),
});
const rescan = () => { work.scan(); home.scan(); };
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; rescan(); await sleep(50); } throw new Error("timeout"); };

// ---------- scenario ----------

const a = await startAgent();
const b = await startAgent();
try {
  rescan();
  await until(() => work.conns.size === 2 && home.conns.size === 2);
  assert.notDeepEqual([...work.conns.keys()].sort(), [], "each profile has one connection per agent");
  assert.equal(new Set([...work.conns.keys()]).size, 2, "agents have their own ids");

  // a web page (no moz-extension origin) cannot talk to the bridge
  const evil = new WebSocket(`ws://127.0.0.1:${BASE}/`, { origin: "https://evil.example" });
  assert.equal(await new Promise((res) => { evil.on("error", () => res(true)); evil.on("open", () => res(false)); }), true);

  // discovery: the agent sees both running profiles and has not asked anyone yet
  const listed = JSON.parse(firstBlock(await call(a, "list_profiles")));
  assert.deepEqual(listed.map((p) => p.profile).sort(), ["home", "work"]);
  assert.ok(listed.every((p) => p.yourState === "not requested"));
  const firstReply = await call(a, "list_profiles");
  assert.equal(firstReply.content.length, 1, "the guide comes once, with the first reply");
  assert.match(text(await call(b, "list_profiles")), /\[FluffyWolf guide\][\s\S]*request_access[\s\S]*list_tabs[\s\S]*screenshot/);

  // with several profiles running the agent has to choose; an unknown profile is an error
  const noChoice = await call(a, "request_access", { name: "Alpha" });
  assert.equal(noChoice.isError, true);
  assert.match(text(noChoice), /Pass profiles/);
  assert.match(text(await call(a, "request_access", { name: "Alpha", profiles: ["nope"] })), /No connected profile "nope"/);
  assert.equal(work.got("request_access").length + home.got("request_access").length, 0);

  // asking one profile: only that profile hears about the agent, and cwd/pid come from the server, not the model
  const t0 = Date.now();
  const granted = text(await call(a, "request_access", { name: "Alpha", purpose: "docs", profiles: ["work"], cwd: "/forged", pid: 1 }));
  assert.match(granted, /work: access granted to window\(s\) 1 \(15 min left\)/);
  assert.ok(Date.now() - t0 >= 250, "waited for the user");
  assert.equal(work.got("request_access").length, 1);
  assert.equal(home.got("request_access").length, 0, "an unchosen profile is not told who the agent is");
  const asked = work.got("request_access")[0][2];
  assert.equal(asked.cwd, process.cwd());
  assert.notEqual(asked.pid, 1);
  assert.equal(asked.name, "Alpha");

  // one active profile is used by default; notices name their profile because two profiles are running
  const tabs = await call(a, "list_tabs");
  assert.match(text(tabs), /work tab/);
  assert.match(text(tabs), /\[FluffyWolf notices.*\]\n- \[work\] tab 1 was navigated by the user/);
  assert.equal(home.got("list_tabs").length, 0);
  // a profile the agent has no access in cannot be reached through the default route
  assert.match(text(await call(a, "snapshot", { tabId: 1 })), /work tree/);

  // second agent: its own state, nothing leaks from the first
  assert.deepEqual(JSON.parse(firstBlock(await call(b, "list_profiles"))).map((p) => p.yourState), ["not requested", "not requested"]);

  // two profiles at once: granted one by one, reported per profile
  const both = text(await call(a, "request_access", { name: "Alpha", profiles: ["work", "home"] }));
  assert.match(both, /work: access granted/);
  assert.match(both, /home: access granted/);
  assert.equal(home.got("request_access").length, 1);

  // routing: without `profile` the call is ambiguous; with it, only that profile is touched; list_tabs merges
  const amb = await call(a, "snapshot", { tabId: 1 });
  assert.equal(amb.isError, true);
  assert.match(text(amb), /several profiles.*pass profile/);
  const before = work.got("snapshot").length;
  assert.match(text(await call(a, "snapshot", { tabId: 1, profile: "home" })), /home tree/);
  assert.equal(work.got("snapshot").length, before);
  const merged = JSON.parse(text(await call(a, "list_tabs")).split("\n\n[FluffyWolf")[0]);
  assert.deepEqual(merged.map((t) => `${t.profile}:${t.title}`).sort(), ["home:home tab", "work:work tab"]);

  // with two profiles connected, notices say which profile they come from
  assert.match(text(await call(a, "list_tabs", { profile: "work" })), /\[work\] tab 1 was navigated by the user/);

  // status lists every profile separately
  const st = JSON.parse(text(await call(a, "status")));
  assert.deepEqual(st.profiles.map((p) => p.profile).sort(), ["home", "work"]);

  // a profile that vanishes fails its pending command at once; the other profile is unaffected
  const t1 = Date.now();
  const r = await call(a, "evaluate", { code: "1", profile: "work" });
  assert.equal(r.isError, true);
  assert.match(text(r), /"work" disconnected/);
  assert.ok(Date.now() - t1 < 3000);
  work.stop();
  await sleep(300);
  assert.match(text(await call(a, "list_tabs", { profile: "work" })), /No connected profile "work"/);
  assert.match(text(await call(a, "snapshot", { tabId: 1 })), /home tree/, "the remaining profile becomes the default again");

  // the profile comes back (same id): the agent can reach it again
  await until(() => work.conns.size === 2);
  assert.deepEqual(JSON.parse(firstBlock(await call(a, "list_profiles"))).map((p) => p.profile).sort(), ["home", "work"]);

  // the user removes the agent from the profile: the profile is no longer routable and the next call says why
  home.push(home.conns.get([...home.conns.keys()].find((id) => home.log.some((l) => l[0] === id && l[1] === "snapshot"))), { ...home.status("unbound", "x"), kicked: "The user ended your access to window 1 and removed you from FluffyWolf MCP." });
  await sleep(200);
  const gone = await call(a, "snapshot", { tabId: 1 });
  assert.equal(gone.isError, true);
  assert.match(text(gone), /home: The user ended your access to window 1 and removed you/);

  // a server that has just started waits a moment for the browser instead of saying that none is connected
  const late = new Client({ name: "late", version: "0" });
  await late.connect(new StdioClientTransport({
    command: "node", args: [join(root, "server", "index.mjs")],
    env: { ...process.env, FLUFFYWOLF_MCP_PORT: "18800" }, stderr: "ignore",
  }));
  const firstCall = call(late, "list_profiles");
  await sleep(1200);
  const lateWs = new WebSocket("ws://127.0.0.1:18800/", { origin: "moz-extension://late" });
  lateWs.on("error", () => {});
  lateWs.on("open", () => lateWs.send(JSON.stringify({ type: "hello", token, version: "t", profileId: randomBytes(16).toString("hex"), profile: "late" })));
  assert.deepEqual(JSON.parse(firstBlock(await firstCall)).map((p) => p.profile), ["late"]);
  lateWs.close();
  await late.close();

  // a reconnecting profile replaces its own old socket instead of piling up
  const seen = [...home.sockets.values()].length;
  assert.ok(seen >= 2);
  console.log("server tests passed");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await a.close();
  await b.close();
  work.stop(); home.stop();
  process.exit(process.exitCode || 0);
}
