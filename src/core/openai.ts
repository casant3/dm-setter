import OpenAI from "openai";
import "dotenv/config";

let client: OpenAI | null = null;

export const setterModel = () => process.env.OPENAI_MODEL || "gpt-5.6";
export const reviewModel = () => process.env.OPENAI_REVIEW_MODEL || setterModel();
export const embeddingModel = () => process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

export function openaiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** Lazily constructed so the app boots without an API key and falls back to the offline engine. */
export function getOpenAI(): OpenAI {
  if (client) return client;
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}
