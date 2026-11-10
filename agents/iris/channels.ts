/**
 * Where Iris posts her call, text and review updates (#iris-calltext-logs).
 * Referenced by Slack's channel ID, not its name: Mark renamed the channel from
 * #iris-call-logs on 2026-10-15, and every post addressed to the old name quietly
 * had nowhere to go — Sabrina Marie's calls on Oct 17 never showed up. An ID
 * survives a rename. IRIS_CALL_LOG_CHANNEL still overrides it.
 */
export const CALL_LOG_CHANNEL = process.env.IRIS_CALL_LOG_CHANNEL || "C0C40DN5P32";
