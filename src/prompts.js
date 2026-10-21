import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

const templates = Object.fromEntries(
  ["humanizer", "judge", "paraphraser", "grammar", "writer"].map((name) => [
    name,
    fs.readFileSync(path.join(dir, `${name}.txt`), "utf8"),
  ]),
);

// Fills {{placeholders}}; an unknown placeholder is a programming error, so fail loudly.
export function render(name, values) {
  return templates[name].replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing value for {{${key}}} in ${name} prompt`);
    return String(values[key]);
  });
}
