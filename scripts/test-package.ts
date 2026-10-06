// Packs dist/, installs the tarball into a scratch project, and checks it
// the way a consumer would: the core in Node ESM, its types via `exports`,
// `crassus/browser` loading in Bun, and the `crassus` bin.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { cascadeDiff, deadDeclarations, parseRules } from "crassus";

const dead = deadDeclarations(".a{color:red}.a{color:blue}");
assert.equal(dead.length, 1);
assert.equal(dead[0].value, "red");

const [after] = parseRules(".a:after{top:0}");
assert.deepEqual(after.specificity, [0, 1, 1]);

const base = parseRules(".x.y{color:red}.x{color:blue}");
const head = parseRules(".x{color:blue}.x.y{color:red}");
assert.equal(cascadeDiff(base, head).flips.length, 0);
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

  console.log(
    "✓ Core works in Node and type-checks; crassus/browser loads in Bun; the crassus bin runs",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
