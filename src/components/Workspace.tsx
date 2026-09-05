"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type AppStatus, type LeadDetail } from "@/lib/client";
import type {
  AgentResult,
  Lead,
  LeadListItem,
  NewLeadInput,
  OutboundAccount,
  Sender,
  SuggestionFeedback,
} from "@/lib/types";
import { ConversationView } from "@/components/ConversationView";
import { CoachingPanel } from "@/components/CoachingPanel";
import { CorpusPanel } from "@/components/CorpusPanel";
import { MemoryPanel } from "@/components/MemoryPanel";
import { CopilotPanel } from "@/components/CopilotPanel";
import { ImportDialog } from "@/components/ImportDialog";
import { LeadsSidebar } from "@/components/LeadsSidebar";
import { NewLeadDialog } from "@/components/NewLeadDialog";
import { AccountsPanel } from "@/components/AccountsPanel";
import { SheetImportPanel } from "@/components/SheetImportPanel";
import { MobileWorkspace } from "@/components/MobileWorkspace";
import { useIsMobile } from "@/components/useMediaQuery";

export function Workspace() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [accounts, setAccounts] = useState<OutboundAccount[]>([]);
  /** `undefined` = every account. */
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [result, setResult] = useState<AgentResult | null>(null);

  const [loadingLeads, setLoadingLeads] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const [showNewLead, setShowNewLead] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCorpus, setShowCorpus] = useState(false);
  const [showCoaching, setShowCoaching] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const [showSheetImport, setShowSheetImport] = useState(false);
  const [rightTab, setRightTab] = useState<"copilot" | "memory">("copilot");
  const isMobile = useIsMobile();

  const refreshLeads = useCallback(async () => {
    // The whole inbox is fetched and filtered client-side: switching account
    // then has to be instant, which is what the phone workflow needs.
    const { leads: next, accounts: nextAccounts } = await api.listLeads();
    setLeads(next);
    if (nextAccounts) setAccounts(nextAccounts.filter((a) => a.active));
    return next;
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    setDetail(await api.getLead(id));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [appStatus, list] = await Promise.all([api.status(), refreshLeads()]);
        setStatus(appStatus);
        if (list.length > 0) setSelectedId((current) => current ?? list[0].id);
      } catch (err) {
        setTopError(err instanceof Error ? err.message : "Could not load the workspace");
      } finally {
        setLoadingLeads(false);
      }
    })();
  }, [refreshLeads]);

  // Selecting a different lead clears the copilot: a suggestion belongs to one thread.
  useEffect(() => {
    if (!selectedId) return;
    setResult(null);
    setGenError(null);
    refreshDetail(selectedId).catch((err) =>
      setTopError(err instanceof Error ? err.message : "Could not load that lead"),
    );
  }, [selectedId, refreshDetail]);

  const updateLead = async (patch: Partial<Lead>) => {
    if (!selectedId) return;
    const { lead } = await api.updateLead(selectedId, patch);
    setDetail((d) => (d ? { ...d, lead } : d));
    await refreshLeads();
  };

  const addMessage = async (sender: Sender, text: string) => {
    if (!selectedId) return;
    await api.addMessage(selectedId, sender, text);
    await Promise.all([refreshDetail(selectedId), refreshLeads()]);
  };

  const generate = async (prospectMessage = "") => {
    if (!selectedId) return;
    setGenerating(true);
    setGenError(null);
    try {
      setResult(await api.generate(selectedId, prospectMessage));
      await refreshDetail(selectedId);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const sendFeedback = async (feedback: SuggestionFeedback, finalMessage: string | null) => {
    if (!result?.suggestion_id || !selectedId) return;
    await api.sendFeedback(result.suggestion_id, feedback, {
      final_message_sent: finalMessage,
      append_to_thread: feedback !== "rejected",
    });
    await Promise.all([refreshDetail(selectedId), refreshLeads()]);
    if (feedback !== "rejected") setResult(null);
  };

  const correctMemory = async (patch: Record<string, string[] | number>) => {
    if (!selectedId) return;
    const res = await fetch(`/api/leads/${selectedId}/memory`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error((payload as { error?: string }).error ?? "Could not save the correction");
    }
    await refreshDetail(selectedId);
  };

  const createLead = async (input: NewLeadInput & { acknowledge_duplicate?: boolean }) => {
    const { lead } = await api.createLead(input);
    await refreshLeads();
    setSelectedId(lead.id);
    setShowNewLead(false);
  };

  const accountFor = (lead: Lead | null | undefined): OutboundAccount | null =>
    lead?.outbound_account_id ? accounts.find((a) => a.id === lead.outbound_account_id) ?? null : null;

  const signOut = async () => {
    await fetch("/api/auth", { method: "DELETE" });
    window.location.href = "/login";
  };

  // A phone gets a different application, not a squeezed one: the columns become
  // screens, and the reply the operator has to copy is the main thing on screen.
  if (isMobile) {
    return (
      <>
        <MobileWorkspace
          status={status}
          leads={leads}
          accounts={accounts}
          accountId={accountId}
          onAccountChange={setAccountId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          detail={detail}
          result={result}
          generating={generating}
          loadingLeads={loadingLeads}
          genError={genError}
          topError={topError}
          onGenerate={(msg) => void generate(msg)}
          onAddMessage={addMessage}
          onFeedback={sendFeedback}
          onUpdateLead={updateLead}
          onCreateLead={createLead}
          onCorrectMemory={correctMemory}
          onSignOut={signOut}
          onManageAccounts={() => setShowAccounts(true)}
        onImportLeads={() => setShowSheetImport(true)}
          onAccountsChanged={() => void refreshLeads()}
          accountFor={accountFor}
        />
        {/* Dialogs live outside the screen switcher so they can open from any
            screen — the accounts panel is reachable from the inbox. */}
        {showAccounts && (
          <AccountsPanel onClose={() => setShowAccounts(false)} onChanged={() => void refreshLeads()} />
        )}
        {showSheetImport && (
          <SheetImportPanel
            accounts={accounts}
            onClose={() => setShowSheetImport(false)}
            onImported={() => void refreshLeads()}
          />
        )}
      </>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>DM Setter Agent</h1>
        {status && (
          <>
            <span className={`badge ${status.supabase_configured ? "good" : "warn"}`}>
              {status.supabase_configured ? "Supabase" : "Local store"}
            </span>
            <span className={`badge ${status.openai_configured ? "good" : "warn"}`}>
              {status.openai_configured ? status.setter_model : "Offline engine"}
            </span>
          </>
        )}
        <span className="spacer" />
        {topError && <span className="error">{topError}</span>}
        <button className="btn small ghost" onClick={() => setShowAccounts(true)}>Accounts</button>
        <button className="btn small ghost" onClick={() => setShowSheetImport(true)}>Import leads</button>
        <button className="btn small ghost" onClick={() => setShowCoaching(true)}>Coaching</button>
        <button className="btn small ghost" onClick={() => setShowCorpus(true)}>Corpus</button>
        <button className="btn small ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      <div className="columns">
        <LeadsSidebar
          leads={leads}
          accounts={accounts}
          accountId={accountId}
          onAccountChange={setAccountId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNewLead={() => setShowNewLead(true)}
          loading={loadingLeads}
        />

        {detail ? (
          <ConversationView
            lead={detail.lead}
            account={accountFor(detail.lead)}
            messages={detail.messages}
            onUpdateLead={updateLead}
            onAddMessage={addMessage}
            onImport={() => setShowImport(true)}
            onGenerate={(msg) => void generate(msg)}
            generating={generating}
          />
        ) : (
          <section className="column" aria-label="Conversation">
            <p className="empty">
              {loadingLeads ? "Loading…" : leads.length === 0 ? "Add a lead to start a conversation." : "Select a lead."}
            </p>
          </section>
        )}

        {rightTab === "copilot" ? (
          <CopilotPanel
            result={result}
            history={detail?.suggestions ?? []}
            generating={generating}
            error={genError}
            engine={status}
            tab={rightTab}
            onTabChange={setRightTab}
            onGenerate={() => void generate()}
            onFeedback={sendFeedback}
          />
        ) : (
          <section className="column" aria-label="Lead memory">
            <div className="column-header">
              <button className="chip" aria-pressed={false} onClick={() => setRightTab("copilot")}>Copilot</button>
              <button className="chip" aria-pressed>Memory</button>
            </div>
            <div className="column-body">
              <div className="copilot">
                <MemoryPanel
                  memory={detail?.memory ?? null}
                  understanding={
                    result
                      ? {
                          level: result.understanding.level,
                          service_explained: result.understanding.service_explained,
                          confusion_reason: result.understanding.confusion_reason,
                        }
                      : null
                  }
                  onCorrect={correctMemory}
                />
              </div>
            </div>
          </section>
        )}
      </div>

      {showAccounts && (
        <AccountsPanel onClose={() => setShowAccounts(false)} onChanged={() => void refreshLeads()} />
      )}
      {showSheetImport && (
        <SheetImportPanel
          accounts={accounts}
          onClose={() => setShowSheetImport(false)}
          onImported={() => void refreshLeads()}
        />
      )}
      {showCorpus && <CorpusPanel onClose={() => setShowCorpus(false)} />}
      {showCoaching && <CoachingPanel onClose={() => setShowCoaching(false)} />}
      {showNewLead && (
        <NewLeadDialog
          onClose={() => setShowNewLead(false)}
          onCreate={createLead}
          accounts={accounts}
          defaultAccountId={accountId ?? null}
        />
      )}
      {showImport && detail && (
        <ImportDialog
          lead={detail.lead}
          onClose={() => setShowImport(false)}
          onImported={async () => {
            await Promise.all([refreshDetail(detail.lead.id), refreshLeads()]);
          }}
        />
      )}
    </div>
  );
}
