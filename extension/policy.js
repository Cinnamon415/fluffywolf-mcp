// Pure helpers (no browser APIs): site matching, text sanitising, notice queue, rights wording.
// Loaded first by the background page and, unchanged, by the unit tests.

// "Same site" is approximated without the Public Suffix List: the registrable domain is the last two labels,
// three when the second-level label is a common one under a country code (co.uk), and one more label under
// well-known multi-tenant suffixes (github.io) so that two users' pages do not count as one site.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);
const TENANT_SUFFIXES = [
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com",
  "blogspot.com", "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net",
  "amazonaws.com", "onrender.com", "fly.dev", "glitch.me", "repl.co",
];

function siteOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return u.protocol + (u.host ? "//" + u.host : "");
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (host.includes(":") || /^[\d.]+$/.test(host) || !host.includes(".")) return host;
  const labels = host.split(".");
  const tenant = TENANT_SUFFIXES.find((s) => host === s || host.endsWith("." + s));
  let take = 2;
  if (tenant) take = tenant.split(".").length + 1;
  else if (labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2])) take = 3;
  return labels.slice(-take).join(".");
}

// `site` is a key produced by siteOf; `url` is a full URL.
const sameSite = (site, url) => site != null && site === siteOf(url);

const stripHash = (url) => String(url || "").split("#")[0];

// Agent-supplied text is shown in the user's UI and in other agents' notices: strip control and bidi characters.
// Built from code points so that no invisible character sits in the source.
const STRIP_RANGES = [[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const STRIP_RE = new RegExp("[" + STRIP_RANGES.map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "]", "g");

function cleanText(s, max) {
  return String(s ?? "").replace(STRIP_RE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Notices for one agent, delivered with the reply to its next command. A later notice with the same key replaces
// the earlier one, so a burst of tab switches collapses into the latest state.
class Notices {
  constructor() { this.items = new Map(); }
  push(key, text) { this.items.delete(key); this.items.set(key, text); }
  drop(key) { this.items.delete(key); }
  get size() { return this.items.size; }
  drain() { const out = [...this.items.values()]; this.items.clear(); return out; }
}

function rightsText(r, allowedCount) {
  if (r.full) {
    return "FULL ACCESS: every tab of the shared window(s), any site, you may open and close tabs.";
  }
  return "RESTRICTED: you see and control only tabs the user allowed with the FluffyWolf MCP button in the address bar "
    + `(${allowedCount} now) and tabs you open yourself; open new tabs: ${r.newTabs ? "yes" : "no"}; `
    + `navigate to other sites: ${r.crossDomain ? "yes" : "no"}; you may close only tabs you opened.`;
}

const shortDir = (p) => String(p || "").split("/").filter(Boolean).slice(-2).join("/") || "/";

if (typeof module !== "undefined") module.exports = { siteOf, sameSite, stripHash, cleanText, Notices, rightsText, shortDir };
