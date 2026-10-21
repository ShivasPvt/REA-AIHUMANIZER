import { GoogleGenAI } from "@google/genai";
import { LLMError, parseJSON } from "./json.js";

// Reads GEMINI_API_KEY (free key from https://aistudio.google.com/apikey).
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Flash is available on the Gemini API free tier.
export const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

const MAX_RETRIES = 3;

// Sends one system prompt + user message and returns the parsed JSON reply.
export async function callJSON({ system, user, temperature }) {
  const config = {
    systemInstruction: system,
    responseMimeType: "application/json",
    maxOutputTokens: 65536,
  };
  if (temperature !== undefined) config.temperature = temperature;

  const response = await withRetry(() => ai.models.generateContent({ model: MODEL, contents: user, config }));

  if (response.promptFeedback?.blockReason) {
    throw new LLMError("The model declined this request.", "refusal");
  }
  const finish = response.candidates?.[0]?.finishReason;
  if (finish === "MAX_TOKENS") {
    throw new LLMError("The response was cut off; try a shorter text.", "max_tokens");
  }
  if (finish && finish !== "STOP") {
    throw new LLMError("The model declined this request.", "refusal");
  }
  return parseJSON(response.text ?? "");
}

// The free tier has low per-minute limits; back off and retry on 429 and 5xx.
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt >= MAX_RETRIES) {
        if (status === 429) throw new LLMError("The free Gemini quota is busy. Wait a minute and try again.", "rate_limited");
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
    }
  }
}
