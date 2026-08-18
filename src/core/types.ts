export type Qualification = {
  fit: number;
  commercial_goal: number;
  media_gap: number;
  value_established: number;
  service_understanding: number;
  interest_signal: number;
};

export type Strategy = {
  stage: string;
  qualification: Qualification;
  total_score: number;
  call_ready: boolean;
  service_confusion: boolean;
  confusion_reason: string | null;
  next_objective: string;
  strategy: string;
  missing_information: string[];
  credibility_needed: boolean;
  credibility_reason: string | null;
  should_explain_service: boolean;
};

export type AgentResult = {
  strategy: Strategy;
  reply: string;
  reviewer: { approved: boolean; issues: string[]; final_reply: string };
};
