// A very small stand-in for the browser, enough to run the page modules under Node.
// It models the two things the tests care about: the element tree, and the fact that an
// IntersectionObserver only ever reports elements that are attached to the document.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

class FakeNode {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === globalThis.document.body; }
  removeChild(kid) { const i = this.childNodes.indexOf(kid); if (i >= 0) { this.childNodes.splice(i, 1); kid.parentNode = null; } return kid; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  append(...kids) {
    for (let kid of kids) {
      if (!(kid instanceof FakeNode)) kid = new FakeText(String(kid));
      kid.remove();
      kid.parentNode = this;
      this.childNodes.push(kid);
    }
  }
}
class FakeText extends FakeNode {
  constructor(text) { super(); this.data = text; }
  get textContent() { return this.data; }
}

function matcher(selector) {
  // compound selectors only: tag, .class, :not(.class), [attr=value]; comma-free, no combinators
  const tag = (selector.match(/^[a-zA-Z0-9]+/) || [null])[0];
  const nots = [...selector.matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]);
  const rest = selector.replace(/:not\([^)]*\)/g, "");
  const classes = [...rest.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const attrs = [...rest.matchAll(/\[([\w-]+)=["']?([^"'\]]+)["']?\]/g)].map((m) => [m[1], m[2]]);
  return (el) => (!tag || el.tagName === tag.toUpperCase())
    && classes.every((c) => el.classList.contains(c)) && nots.every((c) => !el.classList.contains(c))
    && attrs.every(([k, v]) => el.getAttribute(k) === v);
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = {}; this.listeners = {}; this.dataset = {}; this.hidden = false; this.value = "";
    this.style = { setProperty(k, v) { this[k] = v; } };
    const el = this;
    const list = () => (el.attrs.class || "").split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (c) => list().includes(c),
      add: (...cs) => { el.attrs.class = [...new Set([...list(), ...cs])].join(" "); },
      remove: (...cs) => { el.attrs.class = list().filter((c) => !cs.includes(c)).join(" "); },
      toggle: (c, on) => { const want = on === undefined ? !list().includes(c) : !!on; if (want) el.classList.add(c); else el.classList.remove(c); return want; },
    };
  }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "value") this.value = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get textContent() { return this.childNodes.map((k) => k.textContent).join(""); }
  set textContent(v) { for (const k of this.childNodes.slice()) this.removeChild(k); if (v !== "" && v != null) this.append(String(v)); }
  get clientWidth() { return 0; }                                        // charts skip drawing at zero width
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() {}
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(evt) { evt.target ||= this; evt.currentTarget = this; for (const fn of (this.listeners[evt.type] || []).slice()) fn(evt); return true; }
  click() { this.dispatchEvent({ type: "click", preventDefault() {} }); }
  walk(out = []) { for (const k of this.childNodes) if (k instanceof FakeElement) { out.push(k); k.walk(out); } return out; }
  querySelectorAll(selector) { const tests = selector.split(",").map((s) => matcher(s.trim())); return this.walk().filter((el) => tests.some((t) => t(el))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { const t = matcher(selector); let n = this; while (n && !(n instanceof FakeElement && t(n))) n = n.parentNode; return n || null; }
}

// Installs the globals and returns handles for the test. `files` maps "meta.json" etc. to
// objects; anything not listed is read from the repository's data folder.
export function install(files = {}) {
  const doc = new FakeElement("#document");
  doc.body = new FakeElement("body");
  doc.documentElement = new FakeElement("html");
  doc.createElement = (tag) => new FakeElement(tag);
  doc.createElementNS = (ns, tag) => new FakeElement(tag);
  doc.createTextNode = (text) => new FakeText(text);
  const tip = new FakeElement("div"); tip.attrs.id = "tip";
  doc.body.append(tip);
  doc.getElementById = (id) => doc.body.walk().find((el) => el.attrs.id === id) || null;

  const observed = new Set();
  class IO {
    constructor(cb) { this.cb = cb; IO.all.push(this); }
    observe(el) { observed.add([this, el]); }
    unobserve(el) { for (const pair of observed) if (pair[0] === this && pair[1] === el) observed.delete(pair); }
  }
  IO.all = [];
  // What the browser does on its own a moment later: report observed elements that are on the page.
  const flushObservers = () => {
    for (const [io, el] of [...observed]) if (el.isConnected) io.cb([{ isIntersecting: true, target: el }]);
  };

  const store = new Map();
  Object.assign(globalThis, {
    document: doc, Node: FakeNode, IntersectionObserver: IO,
    ResizeObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: true }),                               // reduced motion: no animation frames needed
    requestAnimationFrame: () => 0, innerWidth: 1280, innerHeight: 800,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: async (url) => {
      const name = String(url).replace(/^(\.\.\/)?data\//, "");
      if (name in files) return files[name] == null ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => structuredClone(files[name]) };
      const path = join(REPO, "data", name);
      if (!existsSync(path)) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(path, "utf8")) };
    },
  });
  return { document: doc, flushObservers, FakeElement };
}

export const readData = (name) => JSON.parse(readFileSync(join(REPO, "data", name), "utf8"));
export const hasData = () => existsSync(join(REPO, "data", "meta.json")) && existsSync(join(REPO, "data", "market.json"));
