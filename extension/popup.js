/* global browser */
const $ = (id) => document.getElementById(id);

let windowId = null;
let view = { defaultMinutes: 15, binding: null, candidates: [] };
let defaultInputTouched = false;
let pickerOpen = false;
let shown = {}; // JSON of what each list currently displays, so a poll does not rebuild (and flicker) it

const send = (msg) => browser.runtime.sendMessage({ windowId, ...msg });

const pad = (n) => String(n).padStart(2, "0");
function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
function ago(ms) {
  const m = Math.floor(ms / 60000);
  return m < 1 ? "только что" : `ждёт ${m} мин`;
}

function showError(text) {
  $("error").hidden = !text;
  $("error").textContent = text || "";
}

function apply(next) {
  if (!next) return;
  showError(next.error || "");
  const { error, ...rest } = next;
  view = { ...view, ...rest };
  if (!defaultInputTouched) $("default").value = view.defaultMinutes;
  if (!profileInputTouched && document.activeElement !== $("profile")) $("profile").value = view.profileLabel || "";
  render();
}

// Agent names are chosen by the agent, so they only ever go through textContent.
const agentName = (a) => (a.duplicate ? `${a.name} ${a.label}` : a.name);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function setList(key, node, items, build) {
  const sig = JSON.stringify(items);
  if (shown[key] === sig) return;
  shown[key] = sig;
  node.replaceChildren(...items.map(build));
}

function renderPicker() {
  const picker = $("picker");
  picker.hidden = !pickerOpen;
  $("plank").setAttribute("aria-expanded", String(pickerOpen));
  if (!pickerOpen) return;
  if (!view.candidates.length) {
    setList("picker", picker, [{ empty: true }], () => el("p", "picker-empty", "Пока никто не просит доступ. Агент запросит его сам и появится здесь."));
    return;
  }
  setList("picker", picker, view.candidates.map((c) => ({ ...c, waitingMs: Math.floor(c.waitingMs / 60000) })), (c) => {
    const b = el("button", "cand");
    b.type = "button";
    b.append(el("span", "cand-name", agentName(c)));
    const sub = [c.purpose, `${c.dir} · ${c.label}`].filter(Boolean).join(" — ");
    b.append(el("span", "cand-sub", sub));
    const meta = [ago(c.waitingMs * 60000)];
    if (c.elsewhere.length) meta.push("уже в другом окне");
    if (c.resume) meta.push(`вернёт список: ${c.resume.tabs} вкладок`);
    b.append(el("span", "cand-meta", meta.join(" · ")));
    b.title = c.cwd;
    b.addEventListener("click", async () => {
      pickerOpen = false;
      apply(await send({ type: "bind", connId: c.connId }));
    });
    return b;
  });
}

function render() {
  const bd = view.binding;
  const left = bd ? Math.max(0, bd.expiresAt - Date.now()) : 0;
  const active = left > 0;
  const defMs = view.defaultMinutes * 60000;

  $("logo").src = active ? "icons/icon.svg" : "icons/icon-locked.svg";
  $("pill").textContent = !bd ? "Закрыт" : active ? "Открыт" : "Пауза";
  $("pill").classList.toggle("on", active);

  const count = view.candidates.length;
  $("plank-title").textContent = bd ? agentName(bd.agent) : "Доступ никому не выдан";
  $("plank-sub").textContent = bd ? `${bd.agent.dir} · ${bd.agent.label}${bd.agent.purpose ? ` — ${bd.agent.purpose}` : ""}`
    : count ? "Нажмите, чтобы выбрать сессию" : "Никто не просит доступ";
  $("plank").title = bd ? bd.agent.cwd : "";
  $("plank-count").hidden = !count;
  $("plank-count").textContent = count;
  $("plank").classList.toggle("bound", !!bd);
  renderPicker();

  $("bound").hidden = !bd;
  if (!bd) return;

  $("clock").textContent = active ? fmt(left) : "—";
  $("clock").classList.toggle("off", !active);
  $("clock-label").textContent = active ? "до автоотключения" : "Доступ закрыт";
  $("bar-fill").style.width = active ? `${Math.min(100, (left / Math.max(bd.windowMs, left)) * 100)}%` : "0%";
  $("link").textContent = active ? "Агент может работать в этом окне" : "Агент не может работать, пока вы не разрешите";
  $("link").className = active ? "link ok" : "link";

  const main = $("main");
  if (!active) {
    main.textContent = `Разрешить на ${view.defaultMinutes} мин`;
    main.disabled = false;
    $("hint").textContent = "Окно остаётся за этим агентом, но доступ закрыт.";
  } else {
    const full = left >= defMs;
    main.textContent = full ? "Время уже не меньше обычного" : `Продлить до ${view.defaultMinutes} мин`;
    main.disabled = full;
    $("hint").textContent = full ? "" : "Время вырастет до значения по умолчанию.";
  }
  $("revoke").hidden = !active;

  for (const k of ["newTabs", "crossDomain", "full"]) {
    const box = $(`r-${k}`);
    if (document.activeElement !== box) box.checked = k === "full" ? bd.rights.full : bd.rights[k] || bd.rights.full;
  }
  $("r-newTabs").disabled = bd.rights.full;
  $("r-crossDomain").disabled = bd.rights.full;

  $("tabs-block").hidden = false;
  $("tabs-title").textContent = bd.rights.full ? "Вкладки" : `Разрешённые вкладки (${bd.tabs.length})`;
  $("tabs").hidden = bd.rights.full;
  $("tabs-hint").textContent = bd.rights.full ? "Кнопка в адресной строке скрыта: агент видит все вкладки окна."
    : bd.tabs.length ? "Добавляйте и убирайте вкладки кнопкой в адресной строке." : "Пока ни одной. Разрешите вкладку кнопкой в адресной строке.";
  setList("tabs", $("tabs"), bd.rights.full ? [] : bd.tabs, (t) => {
    const li = el("li", "tab");
    li.append(el("span", "tab-title", t.title));
    if (t.own) li.append(el("span", "tab-own", "своя"));
    const x = el("button", "icon-btn tab-x", "✕");
    x.type = "button";
    x.title = "Убрать доступ к этой вкладке";
    x.addEventListener("click", async () => apply(await send({ type: "untab", tabId: t.id })));
    li.append(x);
    return li;
  });
}

$("plank").addEventListener("click", () => { pickerOpen = !pickerOpen; shown.picker = null; render(); });

$("main").addEventListener("click", async () => {
  const bd = view.binding;
  if (!bd) return;
  apply(await send({ type: bd.expiresAt > Date.now() ? "extend" : "grant" }));
});
$("revoke").addEventListener("click", async () => apply(await send({ type: "revoke" })));
$("unbind").addEventListener("click", async () => apply(await send({ type: "unbind" })));

async function sendRights() {
  apply(await send({
    type: "setRights",
    rights: { newTabs: $("r-newTabs").checked, crossDomain: $("r-crossDomain").checked, full: $("r-full").checked },
  }));
}
for (const k of ["newTabs", "crossDomain", "full"]) $(`r-${k}`).addEventListener("change", sendRights);

$("apply").addEventListener("click", async () => {
  const minutes = Number($("once").value);
  if (!view.binding) return showError("Сначала выберите агента для этого окна.");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return showError("Разовое значение: целое число от 1 до 1440 минут.");
  apply(await send({ type: "grant", minutes }));
  $("once").value = "";
});

$("save").addEventListener("click", async () => {
  const minutes = Number($("default").value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return showError("По умолчанию: целое число от 1 до 1440 минут.");
  defaultInputTouched = false;
  apply(await send({ type: "setDefault", minutes }));
});
$("default").addEventListener("input", () => { defaultInputTouched = true; });

let profileInputTouched = false;
$("profile").addEventListener("input", () => { profileInputTouched = true; });
$("save-profile").addEventListener("click", async () => {
  const label = $("profile").value.trim();
  if (!label) return showError("Имя профиля не может быть пустым.");
  profileInputTouched = false;
  apply(await send({ type: "setProfile", label }));
});

for (const [id, btn] of [["once", "apply"], ["default", "save"], ["profile", "save-profile"]]) {
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") $(btn).click(); });
}

// ---------- theme ----------
// Follows the browser theme. The toggle forces the opposite look until the browser theme changes.
let detected = "light";
let override = null; // "light" | "dark" | null

function luminance(css) {
  const s = String(css).trim();
  let rgb;
  const hex = s.match(/^#([0-9a-f]{6}|[0-9a-f]{3})/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    rgb = (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
  }
  if (rgb.length < 3) return null;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

async function detectScheme() {
  try {
    const t = await browser.theme.getCurrent();
    const c = t?.colors?.popup || t?.colors?.toolbar || t?.colors?.frame;
    const l = c && luminance(Array.isArray(c) ? `rgb(${c.join(",")})` : c);
    if (l != null) return l < 0.5 ? "dark" : "light";
  } catch {}
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function paintTheme() {
  const effective = override || detected;
  document.documentElement.setAttribute("data-theme", effective);
  const btn = $("theme");
  btn.dataset.mode = override || "auto";
  btn.title = override ? `Тема: ${override === "dark" ? "тёмная" : "светлая"} вручную (до смены темы браузера). Нажмите, чтобы вернуть авто` : "Тема: как в браузере. Нажмите, чтобы переключить";
}

async function refreshTheme() {
  const now = await detectScheme();
  const changed = now !== detected;
  detected = now;
  if (changed && override) {
    override = null; // the browser theme changed: manual choice expires
    browser.storage.local.remove(["theme", "themeBase"]);
  }
  paintTheme();
}

(async () => {
  try {
    const s = await browser.storage.local.get(["theme", "themeBase"]);
    detected = await detectScheme();
    // A stored override only survives while the browser theme is still the one it was chosen against.
    if ((s.theme === "light" || s.theme === "dark") && s.themeBase === detected) override = s.theme;
    else if (s.theme) browser.storage.local.remove(["theme", "themeBase"]);
  } catch {}
  paintTheme();
})();

$("theme").addEventListener("click", () => {
  override = override ? null : (detected === "dark" ? "light" : "dark");
  if (override) browser.storage.local.set({ theme: override, themeBase: detected });
  else browser.storage.local.remove(["theme", "themeBase"]);
  paintTheme();
});
try { browser.theme.onUpdated.addListener(refreshTheme); } catch {}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshTheme);

(async () => {
  windowId = (await browser.windows.getCurrent()).id;
  apply(await send({ type: "view" }));
  setInterval(render, 250);
  setInterval(async () => apply(await send({ type: "view" })), 1000);
})();
