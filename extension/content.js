// Content script: page-side half of the bridge (snapshot, click, type, scroll, evaluate).
/* global browser */
(() => {
  if (window.__fwmcp) return;
  window.__fwmcp = true;

  // Lets the local install page detect that the extension is present.
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    document.documentElement.setAttribute("data-fluffywolf-mcp", "1");
  }

  const refToEl = new Map();
  const elToRef = new WeakMap();
  let refCounter = 0;

  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const squash = (s) => (s || "").replace(/\s+/g, " ").trim();

  function refFor(el) {
    let id = elToRef.get(el);
    if (!id) {
      id = "e" + ++refCounter;
      elToRef.set(el, id);
      refToEl.set(id, new WeakRef(el));
    }
    return id;
  }

  function visible(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }

  const LANDMARKS = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog", UL: "list", OL: "list", LI: "listitem", TABLE: "table", TR: "row", TD: "cell", TH: "columnheader" };

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SUMMARY") return "button";
    if (tag === "IMG") return "img";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden") return null;
      if (t === "checkbox" || t === "radio") return t;
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) return "textbox";
    return LANDMARKS[tag] || null;
  }

  const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "slider", "menuitem", "tab", "switch", "option"]);

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return squash(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (squash(t)) return squash(t);
    }
    if (el.labels && el.labels.length) return squash(el.labels[0].textContent);
    if (el.tagName === "IMG") return squash(el.alt);
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type)) return squash(el.value);
    const text = squash(el.innerText ?? el.textContent);
    if (text) return text;
    return squash(el.title || el.placeholder || "");
  }

  function snapshot(maxChars) {
    const lines = [];
    let budget = maxChars || 30000;
    const emit = (depth, s) => {
      const line = "  ".repeat(depth) + s;
      budget -= line.length + 1;
      if (budget >= 0) lines.push(line);
    };

    function walk(node, depth) {
      if (budget < 0) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = squash(node.nodeValue);
        if (t) emit(depth, clip(t, 200));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME)$/i.test(tag)) {
        if (tag === "IFRAME") emit(depth, `iframe [not traversed] src=${clip(node.src || "", 100)}`);
        return;
      }
      if (!visible(node)) return;

      const role = roleOf(node);
      let childDepth = depth;
      if (role) {
        const interactive = INTERACTIVE.has(role);
        let line = role;
        const name = clip(nameOf(node), 100);
        if (name && role !== "list" && role !== "listitem" && role !== "row" && role !== "cell") line += ` "${name}"`;
        if (role === "heading") line += ` level=${node.tagName[1] || node.getAttribute("aria-level") || ""}`;
        if (interactive) line += ` [ref=${refFor(node)}]`;
        if (role === "link" && node.href) line += ` href=${clip(node.getAttribute("href"), 120)}`;
        if (node.matches?.("input, textarea, select")) {
          if (role === "checkbox" || role === "radio") line += node.checked ? " checked" : " unchecked";
          else if (node.type !== "password" && node.value) line += ` value="${clip(node.value, 80)}"`;
          if (node.type === "password") line += " (password field)";
        }
        if (node.disabled) line += " disabled";
        emit(depth, line);
        childDepth = depth + 1;
        // Leaf controls: their label is already printed, don't repeat inner text.
        if (role === "link" || role === "button" || role === "heading" || role === "img" || role === "textbox" || role === "searchbox" || role === "combobox" || role === "checkbox" || role === "radio") {
          if (!node.querySelector("a[href], button, input, select, textarea")) return;
        }
      }
      if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) walk(c, childDepth);
      for (const c of node.childNodes) walk(c, childDepth);
    }

    walk(document.body || document.documentElement, 0);
    const out = lines.join("\n");
    return {
      url: location.href,
      title: document.title,
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight },
      truncated: budget < 0,
      tree: out,
    };
  }

  function target({ ref, selector, x, y }) {
    if (ref) {
      const el = refToEl.get(ref)?.deref();
      if (!el || !el.isConnected) throw new Error(`ref ${ref} is stale; take a new snapshot`);
      return el;
    }
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element matches selector: ${selector}`);
      return el;
    }
    if (typeof x === "number" && typeof y === "number") {
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`no element at (${x}, ${y})`);
      return el;
    }
    return null;
  }

  const mouse = (type, el, cx, cy, extra = {}) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, ...extra }));

  function click(a) {
    const el = target(a);
    if (!el) throw new Error("click needs ref, selector or x/y");
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const cx = typeof a.x === "number" ? a.x : r.left + r.width / 2;
    const cy = typeof a.y === "number" ? a.y : r.top + r.height / 2;
    mouse("mouseover", el, cx, cy);
    mouse("mousedown", el, cx, cy, { buttons: 1 });
    if (el.focus) el.focus({ preventScroll: true });
    mouse("mouseup", el, cx, cy);
    el.click();
    if (a.double) {
      el.click();
      mouse("dblclick", el, cx, cy, { detail: 2 });
    }
    return { clicked: describe(el) };
  }

  function describe(el) {
    return `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}> "${clip(nameOf(el), 60)}"`;
  }

  function setValue(el, value) {
    el.value = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function typeText(a) {
    const el = target(a) || document.activeElement;
    if (!el || el === document.body) throw new Error("nothing to type into: give ref/selector or focus a field first");
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      if (a.clear) document.execCommand("selectAll", false);
      document.execCommand("insertText", false, a.text);
    } else if ("value" in el) {
      setValue(el, a.clear ? a.text : (el.value || "") + a.text);
    } else {
      throw new Error("target is not editable");
    }
    if (a.submit) pressKey("Enter", el);
    return { typed: a.text.length + " chars into " + describe(el) };
  }

  const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };

  function pressKey(spec, el) {
    const parts = spec.split("+");
    const key = parts.pop() || "+";
    const mods = parts.map((m) => m.toLowerCase());
    const init = {
      key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode: KEY_CODES[key] || key.toUpperCase().charCodeAt(0),
      ctrlKey: mods.includes("ctrl") || mods.includes("control"), shiftKey: mods.includes("shift"), altKey: mods.includes("alt"), metaKey: mods.includes("meta") || mods.includes("cmd"),
      bubbles: true, cancelable: true, composed: true,
    };
    const t = el || document.activeElement || document.body;
    const down = t.dispatchEvent(new KeyboardEvent("keydown", init));
    if (down && (key === "Enter" || key.length === 1)) t.dispatchEvent(new KeyboardEvent("keypress", init));
    if (down) {
      if (key === "Enter") {
        if (t.matches?.("button, a[href], summary, input[type=button], input[type=submit], input[type=checkbox]")) t.click();
        else if (t.form && t.matches?.("input, select")) t.form.requestSubmit();
      } else if (key === "Tab") {
        const f = [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")].filter((e) => !e.disabled && e.tabIndex >= 0 && visible(e));
        const i = f.indexOf(t);
        const next = f[(i + (init.shiftKey ? -1 : 1) + f.length) % f.length];
        if (next) next.focus();
      } else if (key.length === 1 && !init.ctrlKey && !init.metaKey && t && "value" in t && !t.readOnly) {
        setValue(t, (t.value || "") + key);
      } else if (key === "Backspace" && t && "value" in t) {
        setValue(t, (t.value || "").slice(0, -1));
      }
    }
    t.dispatchEvent(new KeyboardEvent("keyup", init));
    return { pressed: spec, on: describe(t) };
  }

  function scroll(a) {
    if (a.ref) target(a).scrollIntoView({ block: "center" });
    else if (a.to === "top") scrollTo(0, 0);
    else if (a.to === "bottom") scrollTo(0, document.documentElement.scrollHeight);
    else scrollBy(a.dx || 0, a.dy || 0);
    return { scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
  }

  function getText(a) {
    const el = a.selector ? document.querySelector(a.selector) : document.body;
    if (!el) throw new Error(`no element matches selector: ${a.selector}`);
    const text = (el.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const max = a.maxChars || 20000;
    return { url: location.href, title: document.title, truncated: text.length > max, text: text.slice(0, max) };
  }

  // Runs `code` as an expression or function body and reports back through a DOM event,
  // so the same runner works in the page's own world and in the isolated content-script world.
  function evaluate({ code, world }) {
    const evt = "fwmcp-" + Math.random().toString(36).slice(2);
    const lit = JSON.stringify(code);
    const runner = `(function(){
      const send = (o) => document.dispatchEvent(new CustomEvent(${JSON.stringify(evt)}, { detail: JSON.stringify(o) }));
      const ser = (v) => { try { const seen = new WeakSet(); const s = JSON.stringify(v, (k, x) => {
        if (typeof x === 'bigint') return x + 'n';
        if (typeof x === 'function') return '[Function]';
        if (typeof Node !== 'undefined' && x instanceof Node) return '[Node ' + x.nodeName + ']';
        if (x && typeof x === 'object') { if (seen.has(x)) return '[Circular]'; seen.add(x); }
        return x; }); return s === undefined ? 'undefined' : s; } catch (e) { return String(v); } };
      let fn;
      try { fn = new Function('return (async()=>(' + ${lit} + '\\n))()'); }
      catch (e1) { try { fn = new Function('return (async()=>{' + ${lit} + '\\n})()'); } catch (e2) { send({ error: 'SyntaxError: ' + e2.message }); return; } }
      Promise.resolve().then(fn).then((v) => send({ value: ser(v) }), (e) => send({ error: String((e && e.stack) || e) }));
    })()`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { document.removeEventListener(evt, onResult); reject(new Error("evaluate timed out after 30s")); }, 30000);
      function onResult(ev) {
        clearTimeout(timer);
        document.removeEventListener(evt, onResult);
        let o;
        try { o = JSON.parse(ev.detail); } catch { return reject(new Error("bad evaluate result")); }
        if (o.error) reject(new Error(o.error));
        else resolve({ world: used, value: o.value });
      }
      document.addEventListener(evt, onResult);
      let used = "page";
      try {
        if (world === "isolated") { used = "isolated"; (0, eval)(runner); }
        else {
          try { window.wrappedJSObject.eval(runner); }
          catch (e) {
            if (world === "page") throw e;
            used = "isolated"; // page CSP blocked eval; fall back to the extension sandbox
            (0, eval)(runner);
          }
        }
      } catch (e) {
        clearTimeout(timer);
        document.removeEventListener(evt, onResult);
        reject(e);
      }
    });
  }

  browser.runtime.onMessage.addListener((msg) => {
    try {
      switch (msg.op) {
        case "ping": return Promise.resolve("pong");
        case "snapshot": return Promise.resolve(snapshot(msg.maxChars));
        case "get_text": return Promise.resolve(getText(msg));
        case "click": return Promise.resolve(click(msg));
        case "type": return Promise.resolve(typeText(msg));
        case "key": return Promise.resolve(pressKey(msg.key, msg.ref ? target(msg) : null));
        case "scroll": return Promise.resolve(scroll(msg));
        case "evaluate": return evaluate(msg).catch((e) => ({ error: String(e.message || e) }));
      }
    } catch (e) {
      return Promise.resolve({ error: String(e.message || e) });
    }
    return undefined;
  });
})();
