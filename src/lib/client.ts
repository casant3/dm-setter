"use client";

import type {
  AgentResult,
  AiSuggestion,
  ConversationEvent,
  Lead,
  LeadListItem,
  LeadMemory,
  Message,
  NewLeadInput,
  Sender,
  SuggestionFeedback,
} from "@/lib/types";
import type { ParsedMessage } from "@/lib/dm-parser";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((payload as { error?: string }).error ?? `Request failed (${res.status})`);
  return payload as T;
}

export type LeadDetail = {
  lead: Lead;
  messages: Message[];
  memory: LeadMemory | null;
  events: ConversationEvent[];
  suggestions: AiSuggestion[];
};

export type AppStatus = {
  store_mode: "supabase" | "local";
  supabase_configured: boolean;
  openai_configured: boolean;
  setter_model: string;
};

export type ImportPreview = {
  preview: ParsedMessage[];
  unknown_labels: string[];
  warnings: string[];
  counts: { total: number; setter: number; prospect: number };
};

export const api = {
  status: () => request<AppStatus>("/api/status"),

  listLeads: () => request<{ leads: LeadListItem[]; store_mode: string }>("/api/leads"),

  getLead: (id: string) => request<LeadDetail>(`/api/leads/${id}`),

  createLead: (input: NewLeadInput) =>
    request<{ lead: Lead }>("/api/leads", { method: "POST", body: JSON.stringify(input) }),

  updateLead: (id: string, patch: Partial<Lead>) =>
    request<{ lead: Lead }>(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  addMessage: (id: string, sender: Sender, message_text: string) =>
    request<{ messages: Message[] }>(`/api/leads/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ sender, message_text }),
    }),

  generate: (id: string, prospect_message: string) =>
    request<AgentResult>(`/api/leads/${id}/generate`, {
      method: "POST",
      body: JSON.stringify({ prospect_message }),
    }),

  sendFeedback: (
    suggestionId: string,
    feedback: SuggestionFeedback,
    options: { final_message_sent?: string | null; append_to_thread?: boolean; note?: string | null } = {},
  ) =>
    request<{ suggestion: AiSuggestion }>(`/api/suggestions/${suggestionId}/feedback`, {
      method: "POST",
      body: JSON.stringify({ feedback, ...options }),
    }),

  previewImport: (id: string, transcript: string, label_overrides?: Record<string, Sender>) =>
    request<ImportPreview>(`/api/leads/${id}/import`, {
      method: "POST",
      body: JSON.stringify({ transcript, label_overrides, commit: false }),
    }),

  commitImport: (id: string, transcript: string, label_overrides?: Record<string, Sender>) =>
    request<{ imported: number; messages: Message[] }>(`/api/leads/${id}/import`, {
      method: "POST",
      body: JSON.stringify({ transcript, label_overrides, commit: true }),
    }),
};
