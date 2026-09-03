// ─── Agent Types ───

export type AgentId =
  | "eden"
  | "scout"
  | "iris"
  | "atlas"
  | "ember"
  | "muse"
  | "forge"
  | "lens"
  | "nova"
  | "quarry";

export interface AgentConfig {
  id: AgentId;
  name: string;
  code: string; // 3-letter code (SCT, IRS, etc.)
  role: string;
  color: string;
  systemPrompt: string;
  slackBotToken: string;
  slackSigningSecret: string;
  primaryChannels: string[];
}

// ─── Event Types ───

export type EventType =
  | "lead.captured"
  | "lead.enriched"
  | "lead.qualified"
  | "lead.routed"
  | "appointment.booked"
  | "appointment.cancelled"
  | "nurture.started"
  | "nurture.reactivated"
  | "content.drafted"
  | "content.approved"
  | "content.published"
  | "ad.paused"
  | "ad.scaled"
  | "ad.creative_generated"
  | "report.generated"
  | "alert.bottleneck"
  | "onboarding.step_completed"
  | "system.health_check";

export interface EdenEvent {
  type: EventType;
  agentId: AgentId;
  clientId: string;
  timestamp: string;
  data: Record<string, any>;
}

// ─── Lead Types ───

export type LeadScore = "hot" | "warm" | "cold";
export type LeadType = "buyer" | "seller" | "investor" | "unknown";

export interface Lead {
  id: string;
  clientId: string;
  ghlContactId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  source: string;
  sourceDetail?: string; // e.g., "Mount Pearl - Buyer v3" campaign name
  leadType: LeadType;
  score: number; // 0-100
  scoreCategory: LeadScore;
  propertyInterest?: string;
  budget?: string;
  timeline?: string;
  preApproved?: boolean;
  qualificationNotes?: string;
  assignedAgent?: string;
  pipelineStage?: string;
  capturedAt: string;
  qualifiedAt?: string;
  appointmentAt?: string;
  lastContactedAt?: string;
}

// ─── Client Config Types ───

export interface RoutingRule {
  territory: string;
  agentName: string;
  agentPhone: string;
  agentEmail: string;
}

export interface ClientConfig {
  clientId: string;
  clientName: string;
  ghl: {
    locationId: string;
    apiKey: string;
    pipelineId: string;
    stages: {
      new: string;
      qualified: string;
      appointmentBooked: string;
      underContract: string;
      closed: string;
    };
    calendarId: string;
  };
  meta: {
    adAccountId: string;
    accessToken: string;
    pageId: string;
  };
  routing: {
    rules: RoutingRule[];
    defaultAgent: string;
    roundRobin: boolean;
  };
  forge: {
    cplThreshold: number;
    roasTarget: number;
    dailyBudgetCap: number;
    fatigueThreshold: number;
  };
  iris: {
    qualificationQuestions: string[];
    hotScoreThreshold: number;
    warmScoreThreshold: number;
  };
  slack: {
    clientChannel: string;
  };
}

// ─── Slack Message Types ───

export interface SlackIncomingMessage {
  agentId: AgentId;
  userId: string;
  channelId: string;
  text: string;
  threadTs?: string;
  isDM: boolean;
  timestamp: string;
  // Raw metadata only — BaseAgent.handleMessage downloads the bytes (it
  // needs the agent's own bot token to do that, same as getUserRealName).
  // Only the first file a message carries is used; a chat turn takes at
  // most one attachment, same as the dashboard's chat API.
  file?: { url: string; mimetype: string; name?: string };
}

export interface SlackOutgoingMessage {
  channel: string;
  text: string;
  threadTs?: string;
}
