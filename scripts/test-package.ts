// Packs dist/, installs the tarball into a scratch project, and checks it
// the way a consumer would: the core in Node ESM, its types via `exports`,
// `crassus/browser` loading in Bun, and the `crassus` bin.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const dir = await mkdtemp(join(tmpdir(), "crassus-package-"));

try {
  await $`bun run build`.cwd(root).quiet();

  // The core must stay runtime-neutral.
  const core = await readFile(join(root, "dist/index.js"), "utf8");
  for (const pattern of [
    /\bfrom\s*["']node:/,
    /\bimport\(["']node:/,
    /\brequire\(/,
    /\bprocess\./,
    /\bBuffer\b/,
    /\bBun\./,
  ]) {
    if (pattern.test(core)) throw new Error(`dist/index.js matches ${pattern}`);
  }
  // The page script is inlined by the macro; dist/ ships no page sources.
  const browser = await readFile(join(root, "dist/browser.js"), "utf8");
  if (browser.includes("usage-dom.ts")) {
    throw new Error("dist/browser.js still references the page source");
  }

  const packed = await $`npm pack --pack-destination ${dir} --silent`
    .cwd(join(root, "dist"))
    .text();
  const tarball = join(dir, packed.trim());

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  await $`npm install ${tarball} --no-audit --no-fund --silent`.cwd(dir);

  await writeFile(
    join(dir, "smoke.js"),
    `import assert from "node:assert/strict";
import {
  canonicalContext,
  canonicalSelector,
  cascadeDiff,
  deadDeclarations,
  parseRules,
  SHORTHANDS,
} from "crassus";

const dead = deadDeclarations(".a{color:red}.a{color:blue}");
assert.equal(dead.length, 1);
assert.equal(dead[0].value, "red");

const [after] = parseRules(".a:after{top:0}");
assert.deepEqual(after.specificity, [0, 1, 1]);

const base = parseRules(".x.y{color:red}.x{color:blue}");
const head = parseRules(".x{color:blue}.x.y{color:red}");
assert.equal(cascadeDiff(base, head).flips.length, 0);

const [media] = parseRules("@media (width>=1px)and (hover:hover){.a > .b{top:0}}");
assert.equal(media.context, canonicalContext("media", "(width >= 1px) and (hover: hover)"));
assert.equal(media.selector, canonicalSelector(".a>.b"));

assert.deepEqual(SHORTHANDS["margin-block"], ["margin-block-start", "margin-block-end"]);
`,
  );
  await $`node smoke.js`.cwd(dir);

  await writeFile(
    join(dir, "consumer.ts"),
    `import { type DeadDeclaration, type Rule, deadDeclarations, parseRules } from "crassus";

const rules: Rule[] = parseRules(".a{top:0}", true);
const line: number | undefined = rules[0]?.loc?.line;
const dead: DeadDeclaration[] = deadDeclarations("");
void line;
void dead;
`,
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        skipLibCheck: false,
        types: [],
      },
      files: ["consumer.ts"],
    }),
  );
  const tsc = join(root, "node_modules/.bin/tsc");
  await $`${tsc} -p tsconfig.json`.cwd(dir);

  await writeFile(
    join(dir, "browser.ts"),
    `import { capture, runUsage, serveFixtures } from "crassus/browser";
for (const f of [capture, runUsage, serveFixtures])
  if (typeof f !== "function") throw new Error("missing exports");
`,
  );
  await $`bun browser.ts`.cwd(dir);

  // The bin: installed, executable, and failing on findings.
  await writeFile(join(dir, "a.css"), ".a{color:red}.a{color:blue}");
  const bin = join(dir, "node_modules/.bin/crassus");
  const dead = await $`${bin} dead a.css --json`.cwd(dir).nothrow().quiet();
  if (
    dead.exitCode !== 1 ||
    JSON.parse(dead.text()).results[0].dead.length !== 1
  )
    throw new Error(
      `crassus dead: exit ${dead.exitCode}\n${dead.text()}${dead.stderr}`,
    );

  // The browser commands, bundled into the bin: capture twice (the second
  // after a change), diff, and usage.
  await writeFile(
    join(dir, "crassus.config.js"),
    `export default { browser: { fixtures: "site", sheetMarker: ".x", settleMs: 0, concurrency: 1 } };`,
  );
  await mkdir(join(dir, "site"));
  await writeFile(
    join(dir, "site/p.html"),
    `<!doctype html><style>.x{color:red}.x{color:blue}</style><p class="x">p</p>`,
  );
  const run = async (...args: string[]) => {
    const r = await $`${bin} ${args}`.cwd(dir).nothrow().quiet();
    return { code: r.exitCode, out: `${r.text()}${r.stderr}` };
  };
  const captured = await run("capture", "a", "--no-states");
  if (captured.code !== 0)
    throw new Error(`crassus capture: exit ${captured.code}\n${captured.out}`);
  const used = await run("usage", "--no-states");
  if (used.code !== 0)
    throw new Error(`crassus usage: exit ${used.code}\n${used.out}`);
  await writeFile(
    join(dir, "site/p.html"),
    `<!doctype html><style>.x{color:red}</style><p class="x">p</p>`,
  );
  await run("capture", "b", "--no-states");
  const diff = await run("snapshot-diff", "a", "b");
  if (
    diff.code !== 1 ||
    !diff.out.includes("color: rgb(0, 0, 255) -> rgb(255, 0, 0)")
  )
    throw new Error(`crassus snapshot-diff: exit ${diff.code}\n${diff.out}`);
  const usage = JSON.parse(
    await readFile(join(dir, ".crassus/usage/usage.json"), "utf8"),
  );
  if (usage.deadInFixtures.length !== 1)
    throw new Error(`crassus usage: ${JSON.stringify(usage.deadInFixtures)}`);

  console.log(
    "✓ Core works in Node and type-checks; crassus/browser loads in Bun; the crassus bin runs, browser commands included",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
