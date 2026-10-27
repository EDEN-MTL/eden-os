/**
 * Warnings about data that stops short of the period being shown. Without them a period that runs past the last
 * synced Meta day looks like the ads simply stopped spending.
 */
function addDay(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function freshnessNotes(input: { periodTo: string; metaConnected: boolean; metaLastDay: string | null }): string[] {
  const notes: string[] = [];
  // A day of slack: Meta rows are keyed by the ad account's own day, which can sit a day off the client's.
  if (input.metaConnected && input.metaLastDay && input.periodTo > addDay(input.metaLastDay, 1)) {
    notes.push(`Meta has no data after ${input.metaLastDay}, so ad spend, Meta leads and the numbers built from them leave out the days after that. The ad account may be paused, or the Meta sync is behind.`);
  }
  return notes;
}
