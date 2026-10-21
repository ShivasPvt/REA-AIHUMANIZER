import Anthropic from "@anthropic-ai/sdk";
import { LLMError, parseJSON } from "./json.js";

const client = new Anthropic();

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const USE_FALLBACKS = process.env.ANTHROPIC_FALLBACKS !== "off";

// Sends one system prompt + user message and returns the parsed JSON reply.
// Streams under the hood so long rewrites (3,000 words x 3 variants) never hit HTTP timeouts.
export async function callJSON({ system, user, effort = "medium" }) {
  const params = {
    model: MODEL,
    max_tokens: 64000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort },
  };
  if (USE_FALLBACKS) {
    // On a safety-classifier decline, the API re-runs the request on Anthropic's recommended fallback model.
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const message = await client.beta.messages.stream(params).finalMessage();

  if (message.stop_reason === "refusal") {
    throw new LLMError("The model declined this request.", "refusal");
  }
  if (message.stop_reason === "max_tokens") {
    throw new LLMError("The response was cut off; try a shorter text.", "max_tokens");
  }

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return parseJSON(text);
}
