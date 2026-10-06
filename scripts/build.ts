import { mkdirSync, writeFileSync } from "node:fs";
import { cp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { build } from "bun";

const root = resolve(import.meta.dir, "..");
const outDir = resolve(root, "dist");
const entries = {
  // Runtime-neutral core: browsers, Node, Bun, Deno.
  index: { entry: resolve(root, "src/index.ts"), target: "browser" },
  // Bun.WebView drivers. The page script is inlined by a Bun macro.
  browser: { entry: resolve(root, "src/browser/index.ts"), target: "bun" },
  // The `crassus` bin (Bun).
  cli: { entry: resolve(root, "src/cli/index.ts"), target: "bun" },
} as const;

await rm(outDir, { recursive: true, force: true });

for (const [name, { entry, target }] of Object.entries(entries)) {
  // biome-ignore lint/performance/noAwaitInLoops: a few builds, kept in order for readable logs
  const result = await build({
    entrypoints: [entry],
    outdir: outDir,
    naming: `${name}.js`,
    format: "esm",
    target,
    minify: true,
  });
  if (!result.success) {
    console.error(result.logs.join("\n"));
    process.exit(1);
  }
}

// Declarations for the library entries, mirroring src/ under dist/types/.
const program = ts.createProgram([entries.index.entry, entries.browser.entry], {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  declaration: true,
  emitDeclarationOnly: true,
  rootDir: resolve(root, "src"),
  outDir: resolve(outDir, "types"),
  types: ["bun"],
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
});
// Node's ESM resolution (and TypeScript's `nodenext`) needs file
// extensions on relative specifiers, including inside .d.ts files.
const RELATIVE_SPECIFIER_RE =
  /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)(["'])/g;
const emitted = program.emit(undefined, (fileName, text) => {
  mkdirSync(dirname(fileName), { recursive: true });
  writeFileSync(
    fileName,
    text.replace(
      RELATIVE_SPECIFIER_RE,
      (_, head: string, spec: string, tail: string) =>
        spec.endsWith(".js") ? head + spec + tail : `${head}${spec}.js${tail}`,
    ),
  );
});
const errors = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
if (errors.length > 0 || emitted.emitSkipped) {
  console.error(
    ts.formatDiagnostics(errors, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
  process.exit(1);
}

await Promise.all(
  ["README.md", "LICENSE"].map((file) =>
    cp(resolve(root, file), resolve(outDir, file)),
  ),
);

const manifest = await Bun.file(resolve(root, "package.json")).json();
const pkg = Object.fromEntries(
  Object.entries(manifest).filter(
    ([key]) => key !== "devDependencies" && key !== "scripts",
  ),
);
const types = "./types/index.d.ts";
await writeFile(
  resolve(outDir, "package.json"),
  `${JSON.stringify(
    {
      ...pkg,
      main: "./index.js",
      types,
      bin: { crassus: "./cli.js" },
      exports: {
        ".": { types, import: "./index.js", default: "./index.js" },
        "./browser": {
          types: "./types/browser/index.d.ts",
          bun: "./browser.js",
          default: "./browser.js",
        },
      },
    },
    null,
    2,
  )}\n`,
);

console.log("✓ Build completed");
