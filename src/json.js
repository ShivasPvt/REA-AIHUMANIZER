export class LLMError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// The prompts ask for bare JSON; tolerate code fences or stray prose around it.
export function parseJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LLMError("The model did not return JSON.", "bad_json");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LLMError("The model returned malformed JSON.", "bad_json");
  }
}
