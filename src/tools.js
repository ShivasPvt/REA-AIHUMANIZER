import { callJSON } from "./llm.js";
import { render } from "./prompts.js";
import { LANGUAGES, countWords, frozenList, languageLabel, textToHTML } from "./text.js";

export const LIMITS = {
  maxWords: 3000,
  minWords: { humanize: 30, paraphraser: 10, grammar: 10 },
  maxFrozenTerms: 50,
  maxInstructions: 500,
  maxDescription: 100,
  writerWords: { min: 100, max: 3000 },
};

const HUMANIZE_STYLES = ["casual", "structured"];
const PARAPHRASE_STYLES = ["standard", "fluent", "formal", "academic", "simple", "creative"];
const STRENGTHS = ["low", "medium", "high"];
const LENGTHS = ["shorter", "same", "longer"];
const GRAMMAR_GOALS = ["general", "academic", "business", "casual"];
const WRITER_TYPES = { article: "article", blog_post: "blog post", essay: "opinion piece" };

const FIDELITY_GATE = process.env.FIDELITY_GATE !== "off";

export class ValidationError extends Error {}

function pick(value, allowed, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!allowed.includes(value)) throw new ValidationError(`Unsupported value "${value}". Use one of: ${allowed.join(", ")}.`);
  return value;
}

function parseTerms(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[,\n]/);
  const terms = list.map((t) => String(t).trim()).filter(Boolean);
  if (terms.length > LIMITS.maxFrozenTerms) throw new ValidationError(`At most ${LIMITS.maxFrozenTerms} protected terms.`);
  return terms;
}

function parseLanguage(code) {
  if (!code || code === "auto") return null;
  if (!LANGUAGES[code]) throw new ValidationError(`Unsupported language "${code}".`);
  return code;
}

function inputDraft(body, tool) {
  const text = String(body.text || "").trim();
  const words = countWords(text);
  const min = LIMITS.minWords[tool];
  if (words < min) throw new ValidationError(`Enter at least ${min} words (you have ${words}).`);
  if (words > LIMITS.maxWords) throw new ValidationError(`Enter at most ${LIMITS.maxWords} words (you have ${words}).`);
  const html = body.html ? String(body.html) : textToHTML(text);
  return { text, html, words };
}

// Validates a request and returns { words, run } where run() does the model work.
// Validation happens up front so the client gets a 422 instead of a failed job.
export function prepare(body) {
  const tool = body.type_generation;
  switch (tool) {
    case "humanize":
      return prepareHumanize(body);
    case "paraphraser":
      return prepareParaphrase(body);
    case "grammar":
      return prepareGrammar(body);
    case "generation":
      return prepareWriter(body);
    default:
      throw new ValidationError(`Unknown type_generation "${tool}".`);
  }
}

function prepareHumanize(body) {
  const draft = inputDraft(body, "humanize");
  const mode = pick(body.style, HUMANIZE_STYLES, "casual");
  const frozen = parseTerms(body.frozen_terms);
  const language = parseLanguage(body.language);

  return {
    words: draft.words,
    run: async () => {
      const system = render("humanizer", {
        mode,
        language: languageLabel(language),
        frozen_terms: frozenList(frozen),
      });
      const out = await callJSON({ system, user: draft.html });
      if (out.unsupported_language) return { unsupported_language: true, detected_lang: out.detected_lang };

      const variants = (out.variants || []).filter((v) => v && (v.text || v.html));
      if (!variants.length) throw new Error("No rewrites were returned.");

      const scored = await judge({ original: draft.html, rewrites: variants.map((v) => v.html || v.text), mode });
      const ranked = variants
        .map((v, i) => ({ html: v.html, text: v.text, score: scored[i]?.score ?? 0, fidelity_issues: scored[i]?.fidelity_issues ?? [] }))
        .sort((a, b) => b.score - a.score);

      // Drop variants that changed facts, as long as at least one clean variant exists.
      const clean = ranked.filter((v) => v.fidelity_issues.length === 0);
      const top = (clean.length ? clean : ranked).slice(0, 3);
      return { text: top[0].text, html: top[0].html, variants: top, detected_lang: out.detected_lang };
    },
  };
}

function prepareParaphrase(body) {
  const draft = inputDraft(body, "paraphraser");
  const style = pick(body.style, PARAPHRASE_STYLES, "standard");
  const strength = pick(body.paraphrase_strength, STRENGTHS, "medium");
  const length = pick(body.paraphrase_length, LENGTHS, "same");
  const frozen = parseTerms(body.paraphrase_freeze);
  const instructions = String(body.paraphrase_instructions || "").trim();
  if (instructions.length > LIMITS.maxInstructions) throw new ValidationError(`Instructions must be under ${LIMITS.maxInstructions} characters.`);
  const language = parseLanguage(body.language);

  return {
    words: draft.words,
    run: async () => {
      const system = render("paraphraser", {
        style,
        strength,
        length,
        frozen_terms: frozenList(frozen),
        instructions: instructions || "none",
        language: languageLabel(language),
      });
      const out = await callJSON({ system, user: draft.html });
      const result = { text: out.text, html: out.html, detected_lang: out.detected_lang };
      if (FIDELITY_GATE) {
        const [check] = await judge({ original: draft.html, rewrites: [out.html || out.text], mode: `paraphrase, ${style} style` });
        result.score = check?.score;
        result.fidelity_issues = check?.fidelity_issues ?? [];
      }
      return result;
    },
  };
}

function prepareGrammar(body) {
  const draft = inputDraft(body, "grammar");
  const goal = pick(body.grammar_goal, GRAMMAR_GOALS, "general");
  const language = parseLanguage(body.language);

  return {
    words: draft.words,
    run: async () => {
      const system = render("grammar", { goal, language: languageLabel(language) });
      const out = await callJSON({ system, user: draft.html });
      return { text: out.text, html: out.html, edits: Array.isArray(out.edits) ? out.edits : [] };
    },
  };
}

function prepareWriter(body) {
  const type = pick(body.generation_type, Object.keys(WRITER_TYPES), "article");
  const title = String(body.generation_title || "").trim();
  if (!/\p{L}/u.test(title)) throw new ValidationError("The title must contain letters.");
  if (title.length > 200) throw new ValidationError("The title must be under 200 characters.");
  const description = String(body.generation_description || "").trim();
  if (description.length > LIMITS.maxDescription) throw new ValidationError(`The description must be at most ${LIMITS.maxDescription} characters.`);
  const words = Number.parseInt(body.generation_words, 10);
  const { min, max } = LIMITS.writerWords;
  if (!(words >= min && words <= max)) throw new ValidationError(`Word count must be between ${min} and ${max}.`);
  const language = parseLanguage(body.generation_language || "en");

  return {
    words,
    run: async () => {
      const system = render("writer", {
        type_label: WRITER_TYPES[type],
        language: LANGUAGES[language],
        title,
        description: description || "the writer's choice, following the title",
        words,
      });
      const out = await callJSON({ system, user: `Write the ${WRITER_TYPES[type]} now.` });
      return { text: out.text, html: out.html, word_count: countWords(out.text) };
    },
  };
}

// Scores rewrites against the original. Returns an array aligned with `rewrites`.
async function judge({ original, rewrites, mode }) {
  const system = render("judge", { mode });
  const user = [`ORIGINAL:\n${original}`, ...rewrites.map((r, i) => `REWRITE ${i}:\n${r}`)].join("\n\n");
  const out = await callJSON({ system, user, temperature: 0.1 });
  const byIndex = [];
  for (const s of out.scores || []) {
    if (Number.isInteger(s.index) && s.index >= 0 && s.index < rewrites.length) {
      byIndex[s.index] = { score: Number(s.score) || 0, fidelity_issues: Array.isArray(s.fidelity_issues) ? s.fidelity_issues : [] };
    }
  }
  return byIndex;
}
