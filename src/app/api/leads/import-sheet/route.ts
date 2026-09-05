import { checkDuplicateOutreach } from "@/core/accounts";
import { dedupeCandidates, parseDelimited, parseLeadSheet, type LeadCandidate } from "@/core/lead-sheet";
import { fetchSheetCsv, parseSheetUrl, serviceAccountConfigured } from "@/core/sheets-source";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Cap per import, so one bad paste cannot fill the pipeline. */
const MAX_IMPORT = 1500;

type Body = {
  /** A Google Sheets URL, or the spreadsheet id. */
  sheet_url?: string;
  /** Or the tab's contents, pasted or read from an uploaded file. */
  csv?: string;
  /** Which of our pages sent these. Required to commit. */
  outbound_account_id?: string | null;
  /** Without this, the response is a preview and nothing is written. */
  commit?: boolean;
  /** Rows for months without a year ("22nd of July") are dated into this year. */
  year?: number;
};

/**
 * Imports the daily lead list.
 *
 * Always a two-step: the first call returns what was found — how many days, how
 * many handles, which are new, which are already in the pipeline, and which
 * cells could not be read — and writes nothing. The second call, with `commit`,
 * creates the leads the operator agreed to.
 *
 * The sheet is edited by hand throughout the day, so a partly-filled row is
 * normal. Creating prospects from it unattended would fill the inbox with
 * whatever was mid-edit at the time.
 */
export async function POST(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const body = await readJson<Body>(request);
    const store = getStore();

    // --- get the grid ------------------------------------------------------
    let csv = body.csv?.trim() ?? "";
    let source = "pasted";
    if (!csv && body.sheet_url?.trim()) {
      const ref = parseSheetUrl(body.sheet_url);
      if (!ref) return fail("That does not look like a Google Sheets link");
      const fetched = await fetchSheetCsv(ref);
      csv = fetched.csv;
      source = fetched.via === "service_account" ? "google sheet (service account)" : "google sheet (link)";
    }
    if (!csv) return fail("Paste the tab's contents, or give a Google Sheets link");

    const parsed = parseLeadSheet(parseDelimited(csv), { year: body.year });
    const { unique, duplicates } = dedupeCandidates(parsed.candidates);
    if (unique.length === 0) {
      return fail("No leads found in that sheet. Check the tab has date rows with handles beside them.", 422);
    }

    // --- work out what is actually new -------------------------------------
    const accounts = await store.listOutboundAccounts({ includeInactive: true });
    const accountId = body.outbound_account_id?.trim() || null;
    const account = accountId ? accounts.find((a) => a.id === accountId) ?? null : null;
    if (accountId && !account) return fail("Unknown outbound account", 400);

    const existing = await store.listLeads();
    const onThisAccount = new Set(
      existing
        .filter((l) => (l.outbound_account_id ?? null) === accountId)
        .map((l) => l.instagram_handle.toLowerCase()),
    );
    const elsewhere = new Map(
      existing
        .filter((l) => (l.outbound_account_id ?? null) !== accountId)
        .map((l) => [l.instagram_handle.toLowerCase(), l]),
    );

    const fresh: LeadCandidate[] = [];
    const already: string[] = [];
    const alsoElsewhere: { handle: string; account: string | null }[] = [];

    for (const candidate of unique) {
      if (onThisAccount.has(candidate.instagram_handle)) {
        already.push(candidate.instagram_handle);
        continue;
      }
      const other = elsewhere.get(candidate.instagram_handle);
      if (other) {
        const otherAccount = accounts.find((a) => a.id === other.outbound_account_id);
        alsoElsewhere.push({ handle: candidate.instagram_handle, account: otherAccount?.handle ?? null });
      }
      fresh.push(candidate);
    }

    const summary = {
      source,
      days_with_leads: parsed.days,
      empty_days: parsed.empty_days,
      blocks: parsed.blocks,
      found: unique.length,
      repeated_in_sheet: duplicates,
      new: fresh.length,
      already_in_pipeline: already.length,
      also_on_another_account: alsoElsewhere.length,
      unreadable_cells: parsed.skipped.length,
    };

    // --- preview -----------------------------------------------------------
    if (!body.commit) {
      return ok({
        preview: true,
        summary,
        // Enough to check the parse without returning nine hundred rows.
        sample: fresh.slice(0, 12),
        already_in_pipeline: already.slice(0, 20),
        also_on_another_account: alsoElsewhere.slice(0, 20),
        skipped: parsed.skipped.slice(0, 20),
        accounts: accounts.filter((a) => a.active),
        note:
          parsed.blocks.length > 0
            ? `The sheet labels these rows "${parsed.blocks.join(", ")}". Pick the page that matches before importing.`
            : "The sheet does not say which page sent these, so choose it yourself.",
      });
    }

    // --- commit ------------------------------------------------------------
    if (!accountId) return fail("Choose which outbound account these leads were sent from");
    if (fresh.length > MAX_IMPORT) {
      return fail(`That is ${fresh.length} new leads. Import in smaller batches — the cap is ${MAX_IMPORT}.`, 422);
    }

    const created: string[] = [];
    const failed: { handle: string; error: string }[] = [];

    for (const candidate of fresh) {
      try {
        // The same duplicate rule the manual form uses: another page having this
        // prospect is allowed and recorded, the same page twice is not.
        const duplicate = checkDuplicateOutreach({
          handle: candidate.instagram_handle,
          accountId,
          existing: await store.findLeadsByHandle(candidate.instagram_handle),
          accounts,
        });
        if (duplicate.severity === "blocked") {
          failed.push({ handle: candidate.instagram_handle, error: "already in the pipeline on this account" });
          continue;
        }

        await store.createLead({
          instagram_handle: candidate.instagram_handle,
          outbound_account_id: accountId,
          niche: candidate.note,
          conversation_stage: "NEW_LEAD",
          priority: "medium",
          followup_status: "none",
        });
        created.push(candidate.instagram_handle);
      } catch (error) {
        failed.push({
          handle: candidate.instagram_handle,
          error: error instanceof Error ? error.message : "could not be created",
        });
      }
    }

    return ok({
      imported: created.length,
      skipped: failed.length,
      failures: failed.slice(0, 20),
      summary,
      account: account?.handle ?? null,
      note: "Imported leads start at NEW_LEAD with no messages. Nothing has been sent.",
    });
  } catch (error) {
    return handleError(error);
  }
}

/** Tells the UI whether a sheet link can be used, or only pasting. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  return ok({
    service_account: serviceAccountConfigured(),
    service_account_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null,
    note: serviceAccountConfigured()
      ? "Share the sheet with the service account address, view access is enough."
      : "No Google service account is configured, so a link only works if the sheet is link-shared. Pasting the tab always works.",
  });
}
