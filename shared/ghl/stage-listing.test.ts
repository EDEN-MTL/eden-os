import { afterEach, describe, expect, it, vi } from "vitest";
import { listOpportunitiesInStage } from "./index";

/**
 * listOpportunitiesInStage follows GHL's OWN cursor (meta.startAfter /
 * startAfterId). Found live 2026-09-25: the older paginator, which builds
 * a cursor from the last record's updatedAt, returned 106 of 280 on 3%'s
 * real pipeline.
 */
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockResponses(responses: any[]) {
  const urls: string[] = [];
  global.fetch = vi.fn(async (url: string) => {
    urls.push(url);
    const body = responses[Math.min(urls.length - 1, responses.length - 1)];
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as any;
  }) as any;
  return urls;
}

const opp = (id: string) => ({ id });

describe("listOpportunitiesInStage", () => {
  it("filters by stage and pages with the cursor GHL returns", async () => {
    const urls = mockResponses([
      { opportunities: [opp("a"), opp("b")], meta: { total: 3, startAfter: 111, startAfterId: "b" } },
      { opportunities: [opp("c")], meta: { total: 3, startAfter: 222, startAfterId: "c" } },
    ]);
    const out = await listOpportunitiesInStage("loc", "pipe", "stage", "key", 2);
    expect(out.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(urls[0]).toContain("pipeline_stage_id=stage");
    expect(urls[1]).toContain("startAfterId=b");
    expect(urls[1]).toContain("startAfter=111");
  });

  it("stops on a repeated page instead of looping", async () => {
    mockResponses([{ opportunities: [opp("a"), opp("b")], meta: { startAfter: 1, startAfterId: "x" } }, { opportunities: [opp("a"), opp("b")], meta: { startAfter: 2, startAfterId: "y" } }]);
    expect((await listOpportunitiesInStage("loc", "pipe", "stage", "key", 2)).map((o) => o.id)).toEqual(["a", "b"]);
  });
});
