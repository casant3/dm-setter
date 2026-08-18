import OpenAI from "openai";
import "dotenv/config";
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export const setterModel = process.env.OPENAI_MODEL || "gpt-5.6";
export const reviewModel = process.env.OPENAI_REVIEW_MODEL || setterModel;
export const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
