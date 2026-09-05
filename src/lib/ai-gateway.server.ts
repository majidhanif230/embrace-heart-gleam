import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Google's Gemini API. The text path speaks OpenAI's wire format through
// Gemini's compatibility endpoint, so AI_BASE_URL can be repointed at any other
// OpenAI-compatible provider (OpenAI, OpenRouter, a self-hosted proxy) without
// touching call sites.
export const AI_BASE_URL =
  process.env.AI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai";

// Native (non-OpenAI-shaped) Gemini endpoint, used for image generation and for
// multimodal file extraction, neither of which the compatibility layer exposes.
export const AI_NATIVE_BASE_URL =
  process.env.AI_NATIVE_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";

export const AI_TEXT_MODEL = process.env.AI_TEXT_MODEL ?? "gemini-3-flash-preview";
export const AI_IMAGE_MODEL = process.env.AI_IMAGE_MODEL ?? "gemini-3.1-flash-image";

/** Reads the AI key, failing loudly rather than sending an unauthenticated request. */
export function requireAiApiKey(): string {
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error("AI_API_KEY is not configured");
  return key;
}

export function createAiProvider(apiKey: string) {
  return createOpenAICompatible({
    name: "gemini",
    baseURL: AI_BASE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}
