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
  OutboundAccount,
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

/** A prospect already being contacted from another page. */
export type DuplicateWarning = {
  severity: "blocked" | "warn" | "none";
  message: string;
  can_proceed: boolean;
  matches: { lead_id: string; account_handle: string | null; conversation_stage: string | null }[];
};

export class DuplicateProspectError extends Error {
  constructor(readonly duplicate: DuplicateWarning) {
    super(duplicate.message);
    this.name = "DuplicateProspectError";
  }
}

export const api = {
  status: () => request<AppStatus>("/api/status"),

  listAccounts: (includeInactive = false) =>
    request<{ accounts: OutboundAccount[] }>(`/api/accounts${includeInactive ? "?all=1" : ""}`),

  createAccount: (input: { handle: string; display_name?: string | null; notes?: string | null }) =>
    request<{ account: OutboundAccount }>("/api/accounts", { method: "POST", body: JSON.stringify(input) }),

  updateAccount: (id: string, patch: { display_name?: string | null; active?: boolean; notes?: string | null }) =>
    request<{ account: OutboundAccount }>(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  listLeads: (accountId?: string | null) =>
    request<{ leads: LeadListItem[]; accounts: OutboundAccount[]; store_mode: string }>(
      `/api/leads${accountId ? `?account=${encodeURIComponent(accountId)}` : ""}`,
    ),

  getLead: (id: string) => request<LeadDetail>(`/api/leads/${id}`),

  /**
   * Creates a lead.
   *
   * Throws `DuplicateProspectError` when the same prospect is already being
   * contacted from another page — the operator has to see that before a second
   * page messages someone, and can then retry with `acknowledge_duplicate`.
   */
  createLead: async (input: NewLeadInput & { acknowledge_duplicate?: boolean }) => {
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      lead?: Lead;
      error?: string;
      duplicate?: DuplicateWarning;
      requires_acknowledgement?: boolean;
    };
    if (res.status === 409 && payload.requires_acknowledgement && payload.duplicate) {
      throw new DuplicateProspectError(payload.duplicate);
    }
    if (!res.ok) throw new Error(payload.error ?? `Request failed (${res.status})`);
    return payload as { lead: Lead; duplicate: DuplicateWarning | null };
  },

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
