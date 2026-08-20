import type { FollowupStatus, Priority } from "@/lib/types";

export const FOLLOWUP_LABELS: Record<FollowupStatus, string> = {
  none: "No follow-up",
  waiting_on_them: "Waiting on them",
  owed_reply: "We owe a reply",
  scheduled: "Follow-up scheduled",
  overdue: "Overdue",
  closed: "Closed",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export function priorityTone(priority: Priority | null): string {
  if (priority === "urgent") return "urgent";
  if (priority === "high") return "high";
  return "";
}

export function followupTone(status: FollowupStatus | null): string {
  if (status === "overdue" || status === "owed_reply") return "bad";
  if (status === "scheduled") return "accent";
  if (status === "waiting_on_them") return "warn";
  return "";
}

/** Compact relative time for the sidebar; the conversation shows absolute times. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function absoluteTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
