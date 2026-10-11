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
    const record = (el, into, suffix) => {
      const key = pathOf(el) + (suffix || "");
      into[key] = read(el, null);
      const b = read(el, "::before"); if (b) into[key + "::before"] = b;
      const a = read(el, "::after"); if (a) into[key + "::after"] = a;
    };
    window.__ccs = {
      snapshot() {
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
      snapshotState(idx, state) {
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
