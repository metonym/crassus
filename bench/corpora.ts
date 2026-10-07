import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const read = (specifier: string) =>
  readFileSync(require.resolve(specifier), "utf8");

/** Real-world stylesheets, from devDependencies. */
export const CORPORA: { name: string; css: string }[] = [
  {
    name: "carbon-components-svelte all.css",
    css: read("carbon-components-svelte/css/all.css"),
  },
  {
    name: "carbon-components-svelte white.css",
    css: read("carbon-components-svelte/css/white.css"),
  },
  { name: "@carbon/styles", css: read("@carbon/styles/css/styles.css") },
  { name: "bootstrap.css", css: read("bootstrap/dist/css/bootstrap.css") },
  { name: "bulma.css", css: read("bulma/css/bulma.css") },
  { name: "primer.css", css: read("@primer/css/dist/primer.css") },
  { name: "tailwind 2 (full)", css: read("tailwindcss/dist/tailwind.css") },
  { name: "open-props", css: read("open-props/open-props.min.css") },
];
