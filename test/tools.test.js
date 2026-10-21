import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Stub the model so the pipeline can be tested without an API key.
const calls = [];
let replies = [];
mock.module("../src/llm.js", {
  namedExports: {
    MODEL: "test-model",
    callJSON: async (args) => {
      calls.push(args);
      return replies.shift();
    },
  },
});

const { prepare, ValidationError } = await import("../src/tools.js");
const { render } = await import("../src/prompts.js");
const { parseJSON } = await import("../src/json.js");

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

function reset(next) {
  calls.length = 0;
  replies = next;
}

test("every prompt renders with no leftover placeholders", () => {
  const out = [
    render("humanizer", { mode: "casual", language: "English", frozen_terms: "none" }),
    render("judge", { mode: "casual" }),
    render("paraphraser", { style: "standard", strength: "medium", length: "same", frozen_terms: "none", instructions: "none", language: "English" }),
    render("grammar", { goal: "general", language: "English" }),
    render("writer", { type_label: "article", language: "English", title: "T", description: "D", words: 500 }),
  ];
  for (const prompt of out) assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
  assert.throws(() => render("judge", {}), /Missing value/);
});

test("parseJSON tolerates code fences and rejects non-JSON", () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJSON("no json here"), /did not return JSON/);
});

test("validation enforces word limits and option values", () => {
  assert.throws(() => prepare({ type_generation: "humanize", text: words(29) }), ValidationError);
  assert.throws(() => prepare({ type_generation: "humanize", text: words(3001) }), ValidationError);
  assert.throws(() => prepare({ type_generation: "humanize", text: words(40), style: "pirate" }), ValidationError);
  assert.throws(() => prepare({ type_generation: "paraphraser", text: words(9) }), ValidationError);
  assert.throws(() => prepare({ type_generation: "generation", generation_title: "1234", generation_words: 500 }), /letters/);
  assert.throws(() => prepare({ type_generation: "generation", generation_title: "Hi", generation_words: 500, generation_description: "x".repeat(101) }), /100/);
  assert.throws(() => prepare({ type_generation: "nope" }), ValidationError);
  assert.equal(prepare({ type_generation: "humanize", text: words(30) }).words, 30);
});

test("humanizer ranks variants by judge score and drops ones that changed facts", async () => {
  reset([
    { variants: [{ html: "<p>A</p>", text: "A" }, { html: "<p>B</p>", text: "B" }, { html: "<p>C</p>", text: "C" }], detected_lang: "en" },
    {
      scores: [
        { index: 0, score: 70, fidelity_issues: [] },
        { index: 1, score: 95, fidelity_issues: ["changed 2019 to 2018"] },
        { index: 2, score: 88, fidelity_issues: [] },
      ],
      best: 1,
    },
  ]);
  const job = prepare({ type_generation: "humanize", text: words(40), style: "structured", frozen_terms: "Acme, GDPR" });
  const data = await job.run();

  assert.deepEqual(data.variants.map((v) => v.text), ["C", "A"]);
  assert.equal(data.text, "C");
  assert.match(calls[0].system, /Mode: structured/);
  assert.match(calls[0].system, /"Acme", "GDPR"/);
  assert.match(calls[1].user, /REWRITE 2:\n<p>C<\/p>/);
});

test("humanizer keeps flagged variants when none are clean", async () => {
  reset([
    { variants: [{ html: "A", text: "A" }, { html: "B", text: "B" }] },
    { scores: [{ index: 0, score: 40, fidelity_issues: ["x"] }, { index: 1, score: 35, fidelity_issues: ["y"] }] },
  ]);
  const data = await prepare({ type_generation: "humanize", text: words(40) }).run();
  assert.deepEqual(data.variants.map((v) => v.text), ["A", "B"]);
});

test("humanizer passes through unsupported_language", async () => {
  reset([{ unsupported_language: true, detected_lang: "ja" }]);
  const data = await prepare({ type_generation: "humanize", text: words(40) }).run();
  assert.deepEqual(data, { unsupported_language: true, detected_lang: "ja" });
  assert.equal(calls.length, 1);
});

test("paraphraser runs the fidelity gate", async () => {
  reset([{ html: "<p>P</p>", text: "P", detected_lang: "en" }, { scores: [{ index: 0, score: 81, fidelity_issues: ["dropped a date"] }] }]);
  const data = await prepare({ type_generation: "paraphraser", text: words(20), paraphrase_strength: "high", paraphrase_instructions: "Keep it short" }).run();
  assert.equal(data.text, "P");
  assert.equal(data.score, 81);
  assert.deepEqual(data.fidelity_issues, ["dropped a date"]);
  assert.match(calls[0].system, /Strength: high/);
  assert.match(calls[0].system, /Extra instructions from the user: Keep it short/);
});

test("grammar returns the edit list", async () => {
  const edits = [{ original: "their going", corrected: "they're going", type: "grammar", reason: "contraction" }];
  reset([{ html: "<p>x</p>", text: "x", edits }]);
  const data = await prepare({ type_generation: "grammar", text: words(12), grammar_goal: "business" }).run();
  assert.deepEqual(data.edits, edits);
  assert.match(calls[0].system, /GOAL: business/);
});

test("writer fills the brief", async () => {
  reset([{ html: "<p>one two three</p>", text: "one two three", word_count: 999 }]);
  const data = await prepare({
    type_generation: "generation",
    generation_type: "essay",
    generation_title: "Remote work",
    generation_words: "800",
    generation_language: "fr",
  }).run();
  assert.equal(data.word_count, 3);
  assert.match(calls[0].system, /original opinion piece in French/);
  assert.match(calls[0].system, /Target length: 800 words/);
});
