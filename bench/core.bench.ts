import { deadDeclarations, parseRules } from "crassus";
import { parse } from "css-tree";
import { group, task } from "ostia";
import { parseStylesheet } from "../src/core/parse";
import { CORPORA } from "./corpora";

for (const { name, css } of CORPORA) {
  const kb = Math.round(css.length / 1000);

  group(`${name}, ${kb} kB: parse`, () => {
    task("crassus parseStylesheet", () => parseStylesheet(css));
    task("css-tree parse", () => parse(css));
  });

  group(`${name}, ${kb} kB: rules`, () => {
    task("parseRules", () => parseRules(css));
    task("parseRules + positions", () => parseRules(css, true));
  });

  group(`${name}, ${kb} kB: dead declarations`, () => {
    task("deadDeclarations", () => deadDeclarations(css));
  });
}
