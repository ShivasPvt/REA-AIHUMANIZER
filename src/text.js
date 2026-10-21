export const LANGUAGES = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  nl: "Dutch",
};

export function countWords(text) {
  const words = String(text || "").trim().match(/\S+/g);
  return words ? words.length : 0;
}

export function escapeHTML(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Plain text -> simple HTML paragraphs, for clients that only send `text`.
export function textToHTML(text) {
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${escapeHTML(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function languageLabel(code) {
  if (code && LANGUAGES[code]) return LANGUAGES[code];
  return "the same language as the draft (detect it; supported: " + Object.values(LANGUAGES).join(", ") + ")";
}

export function frozenList(terms) {
  return terms.length ? terms.map((t) => `"${t}"`).join(", ") : "none";
}
