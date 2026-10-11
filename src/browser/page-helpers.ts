/**
 * Page function `(doc, selectors)`: the indexes of the selectors that match
 * in `doc`, and the `<body>` elements they match; `all` when one matches
 * `<html>` or `<body>` (everything inherits from them) or the engine
 * rejects it.
 */
export const MATCH_SELECTORS = `(doc, selectors) => {
  const hits = [];
  const els = new Set();
  let all = false;
  selectors.forEach((s, i) => {
    let found;
    try { found = doc.querySelectorAll(s); } catch { all = true; hits.push(i); return; }
    if (found.length) hits.push(i);
    for (const el of found) {
      if (el === doc.documentElement || el === doc.body) all = true;
      else if (doc.body.contains(el)) els.add(el);
    }
  });
  return { hits, all, els };
}`;

// From carbon-components-svelte's e2e/cascade-snapshot.ts, so captures compare
// byte for byte. An expression, as evaluate() takes no statements.
export const PAGE_HELPERS = `
  (() => {
    // Only longhands the stylesheets set, so diffs stay about the cascade.
    // Custom properties are theme tokens: skipped.
    // Plus any the caller adds, so two captures can record the same set.
    const declared = new Set(window.__crProps || []);
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const visit = (list) => {
        for (const rule of list) {
          if (rule.style) for (let i = 0; i < rule.style.length; i++) {
            const name = rule.style[i];
            if (!name.startsWith("--")) declared.add(name);
          }
          if (rule.cssRules) visit(rule.cssRules);
        }
      };
      visit(rules);
    }
    let props = Array.from(declared).sort();
    // Set by scope(): the elements a snapshot reads, when not all.
    let only = null;
    let matched = new Set();
    const eachRule = (fn) => {
      const visit = (list) => {
        for (const rule of list) {
          fn(rule);
          if (rule.cssRules) visit(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        visit(rules);
      }
    };
    const pathOf = (el) => {
      const parts = [];
      let node = el;
      while (node && node !== document.documentElement) {
        const sig = node.tagName.toLowerCase() + (node.className && typeof node.className === "string" && node.className.trim() ? "." + node.className.trim().split(/\\s+/).sort().join(".") : "");
        let nth = 0;
        let sib = node.previousElementSibling;
        while (sib) {
          const s = sib.tagName.toLowerCase() + (sib.className && typeof sib.className === "string" && sib.className.trim() ? "." + sib.className.trim().split(/\\s+/).sort().join(".") : "");
          if (s === sig) nth++;
          sib = sib.previousElementSibling;
        }
        parts.unshift(nth ? sig + "[" + nth + "]" : sig);
        node = node.parentElement;
      }
      return parts.join(">");
    };
    const read = (el, pseudo) => {
      const cs = getComputedStyle(el, pseudo || null);
      if (pseudo && (cs.content === "none" || cs.content === "")) return null;
      const out = {};
      for (const p of props) out[p] = cs.getPropertyValue(p);
      return out;
    };
    // Why an element's box can't be seen where it is: off the page, or
    // clipped away by an overflow ancestor (followed through in-flow boxes
    // only, as positioned ones can escape it).
    const ALL = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    let clips = new Map();
    const outOfFlow = (el) => {
      const p = getComputedStyle(el).position;
      return p === "absolute" || p === "fixed";
    };
    // The clip an in-flow child of \`el\` is under, in viewport coordinates.
    const clipFor = (el) => {
      if (!el || el === document.body || el === document.documentElement) return ALL;
      let c = clips.get(el);
      if (c) return c;
      c = outOfFlow(el) ? ALL : clipFor(el.parentElement);
      const cs = getComputedStyle(el);
      const x = cs.overflowX !== "visible";
      const y = cs.overflowY !== "visible";
      if (x || y) {
        const r = el.getBoundingClientRect();
        const l = r.left + el.clientLeft;
        const t = r.top + el.clientTop;
        c = {
          l: x ? Math.max(c.l, l) : c.l,
          t: y ? Math.max(c.t, t) : c.t,
          r: x ? Math.min(c.r, l + el.clientWidth) : c.r,
          b: y ? Math.min(c.b, t + el.clientHeight) : c.b,
        };
      }
      clips.set(el, c);
      return c;
    };
    const unseen = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      const de = document.documentElement;
      const w = Math.max(de.scrollWidth, de.clientWidth);
      const h = Math.max(de.scrollHeight, de.clientHeight);
      const left = r.left + scrollX;
      const top = r.top + scrollY;
      if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || left >= w || top >= h)
        return "offscreen";
      if (outOfFlow(el)) return null;
      const c = clipFor(el.parentElement);
      if (Math.min(r.right, c.r) <= Math.max(r.left, c.l) || Math.min(r.bottom, c.b) <= Math.max(r.top, c.t))
        return "clipped by an overflow ancestor";
      return null;
    };
    const record = (el, into, suffix) => {
      const key = pathOf(el) + (suffix || "");
      into[key] = read(el, null);
      const why = unseen(el);
      if (why) into[key]["--cr-hidden"] = why;
      // Its place among its parent's children, for an nth-child selector.
      if (!suffix) into[key]["--cr-nth"] = String(Array.prototype.indexOf.call(el.parentElement.children, el) + 1);
      const b = read(el, "::before"); if (b) into[key + "::before"] = b;
      const a = read(el, "::after"); if (a) into[key + "::after"] = a;
    };
    window.__ccs = {
      // Reads the page again with every custom property named \`prefix…\`
      // set to a sentinel of its type (a hue, an odd length, a font family
      // of its own), and returns, per element read, the properties whose
      // value carries a sentinel: the tokens driving them.
      tokens(prefix) {
        const names = new Set();
        const first = new Map();
        eachRule((rule) => {
          if (rule.style) for (let i = 0; i < rule.style.length; i++) {
            const name = rule.style[i];
            if (!name.startsWith(prefix)) continue;
            names.add(name);
            if (!first.has(name)) first.set(name, rule.style.getPropertyValue(name).trim());
          }
        });
        const root = getComputedStyle(document.documentElement);
        const marks = [];
        const decls = [];
        Array.from(names).sort().forEach((name, i) => {
          const value = root.getPropertyValue(name).trim() || first.get(name) || "";
          let mark = null;
          if (value && CSS.supports("color", value)) mark = "rgb(" + ((i >> 8) & 255) + ", " + (i & 255) + ", 251)";
          else if (value && CSS.supports("width", value) && !CSS.supports("width", value + "a")) mark = (1000 + (i % 9000)) / 100 + 0.003 + "px";
          else if (value && CSS.supports("font-family", value) && value.includes(",")) mark = '"cr-token-' + i + '"';
          if (!mark) return;
          marks.push([name, mark.replace(/^"|"$/g, "")]);
          decls.push(name + ": " + mark + " !important;");
        });
        const style = document.createElement("style");
        // No transitions: they'd start from the old value, hiding the sentinel.
        style.textContent = ":root, *, *::before, *::after { " + decls.join(" ") + " transition: none !important; }";
        document.head.append(style);
        const read = this.snapshot();
        style.remove();
        const out = {};
        for (const [key, record] of Object.entries(read)) {
          for (const [prop, value] of Object.entries(record)) {
            if (prop.startsWith("--")) continue;
            const hit = marks.filter(([, m]) => value.includes(m)).map(([n]) => n);
            if (hit.length) (out[key] ??= {})[prop] = hit;
          }
        }
        return { tokens: marks.map(([n]) => n), tracked: out };
      },
      snapshot() {
        clips = new Map();
        const out = {};
        for (const el of document.querySelectorAll("body *"))
          if (!only || only.has(el)) record(el, out, "");
        return out;
      },
      match(selectors) {
        const { hits, all, els } = (${MATCH_SELECTORS})(document, selectors);
        matched = els;
        return { hits, all, elements: els.size };
      },
      // Reads only \`read\` (null: every property) from now on, and only the
      // matched elements, their descendants and ancestors, unless \`every\`.
      // Returns the indexes tagInteractive will give the elements whose
      // forced states can record a matched element (null: all of them).
      scope(read, every, selector, max) {
        if (read) {
          const keep = new Set(read);
          props = props.filter((p) => keep.has(p));
        }
        if (every) return null;
        const reached = new Set();
        for (const m of matched) {
          reached.add(m);
          for (const d of m.querySelectorAll("*")) reached.add(d);
        }
        only = new Set();
        for (const el of reached)
          for (let a = el; a && !only.has(a); a = a.parentElement) only.add(a);
        const out = [];
        Array.from(document.querySelectorAll(selector)).slice(0, max).forEach((el, i) => {
          if (only.has(el)) out.push(i);
        });
        return out;
      },
      tagInteractive(selector, max) {
        const els = Array.from(document.querySelectorAll(selector)).slice(0, max);
        els.forEach((el, i) => el.setAttribute("data-ccs-idx", String(i)));
        return els.length;
      },
      stateSelectors() {
        const out = new Set();
        eachRule((r) => {
          const t = r.selectorText;
          if (t && (t.includes(":hover") || t.includes(":focus") || t.includes(":active"))) out.add(t);
        });
        return Array.from(out);
      },
      // Per tagged element, the states whose forcing can restyle what its
      // state records hold: a trigger's prefix matches it (or, for
      // :focus-within, it or an ancestor), or the user agent's rules apply.
      stateMatters(triggers, n, ua) {
        const els = Array.from({ length: n }, (_, i) => document.querySelector('[data-ccs-idx="' + i + '"]'));
        const out = els.map(() => new Set());
        for (const t of triggers) {
          let hits = null;
          if (t.prefix) {
            try { hits = new Set(document.querySelectorAll(t.prefix)); } catch {}
          }
          els.forEach((el, i) => {
            if (!el) return;
            let on = !hits;
            if (hits) for (let a = el; a && !on; a = t.within ? a.parentElement : null) on = hits.has(a);
            if (on) out[i].add(t.state);
          });
        }
        els.forEach((el, i) => {
          if (!el) return;
          out[i].add("focus");
          for (const [state, selector] of Object.entries(ua)) if (el.matches(selector)) out[i].add(state);
        });
        return out.map((s) => Array.from(s));
      },
      // The keys a state's records would take, and the plain records they'd
      // equal unforced: [stateKey, plainKey] per element, in record order.
      // Null when an animated element is among them: stopped, it reads
      // differently. \`frozen\`: transition and animation values under the
      // freeze, the same on every element.
      statePaths(pairs) {
        const animated = window.__crAnimated || new Set();
        const cs = getComputedStyle(document.body);
        const frozen = {};
        for (const p of props)
          if (p.startsWith("transition") || p.startsWith("animation")) frozen[p] = cs.getPropertyValue(p);
        let still = true;
        const keys = pairs.map(([idx, state]) => {
          const el = document.querySelector('[data-ccs-idx="' + idx + '"]');
          if (!el) return [];
          const out = [];
          const suffix = "@" + state;
          const set = [el, ...el.querySelectorAll("*")];
          if (el.parentElement && el.parentElement !== document.body) set.unshift(el.parentElement);
          for (const e of set) {
            if (animated.has(e)) still = false;
            const p = pathOf(e);
            out.push([p + suffix + (e === el.parentElement ? "^" : ""), p]);
          }
          return out;
        });
        return { keys: still ? keys : null, frozen };
      },
      // State records read without forcing, in order: what forcing gives
      // when no rule uses the state there.
      snapshotStates(pairs) {
        const out = {};
        for (const [i, state] of pairs) Object.assign(out, this.snapshotState(i, state));
        return out;
      },
      snapshotState(idx, state) {
        clips = new Map();
        const el = document.querySelector('[data-ccs-idx="' + idx + '"]');
        const out = {};
        if (!el) return out;
        const suffix = "@" + state;
        if (el.parentElement && el.parentElement !== document.body) record(el.parentElement, out, suffix + "^");
        record(el, out, suffix);
        for (const d of el.querySelectorAll("*")) record(d, out, suffix);
        return out;
      },
    };
  })()
`;
