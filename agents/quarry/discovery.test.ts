import { afterEach, describe, expect, it, vi } from "vitest";
import { discover, worthDetailing } from "./discovery";
import { SearchSpec } from "./config";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const spec = (query: string, category: any): SearchSpec => ({ query, category, maxResults: 20 });

/**
 * Mocks the two Places endpoints. searchText is a POST to /places:searchText;
 * details is a GET to /places/{id}. Counts each so tests can assert on how
 * many billable calls a run actually made.
 */
function mockPlaces(resultsPerQuery: Record<string, string[]>) {
  const calls = { search: 0, details: 0 };
  global.fetch = vi.fn(async (url: any, init: any) => {
    const href = String(url);
    if (href.includes(":searchText")) {
      calls.search++;
      const q = JSON.parse(init.body).textQuery;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          places: (resultsPerQuery[q] ?? []).map((id) => ({
            id,
            displayName: { text: `Biz ${id}` },
            formattedAddress: "1 Rue Test, Montreal",
            businessStatus: "OPERATIONAL",
          })),
        }),
        text: async () => "",
      } as any;
    }
    calls.details++;
    const id = href.split("/places/")[1].split("?")[0];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id,
        displayName: { text: `Biz ${id}` },
        nationalPhoneNumber: "(514) 555-0100",
        websiteUri: null,
        photos: [{ name: "p1" }, { name: "p2" }, { name: "p3" }, { name: "p4" }, { name: "p5" }, { name: "p6" }],
      }),
      text: async () => "",
    } as any;
  }) as any;
  return calls;
}

describe("worthDetailing", () => {
  const hit = (id: string, businessStatus: string | null) => ({
    placeId: id,
    name: "x",
    formattedAddress: null,
    businessStatus,
  });

  it("skips a place already processed", () => {
    expect(worthDetailing(hit("a", "OPERATIONAL"), new Set(["a"]))).toBe(false);
  });

  it("skips permanently closed businesses", () => {
    expect(worthDetailing(hit("a", "CLOSED_PERMANENTLY"), new Set())).toBe(false);
  });

  it("keeps a business with no reported status rather than dropping it", () => {
    expect(worthDetailing(hit("a", null), new Set())).toBe(true);
  });
});

describe("discover", () => {
  it("spreads the details budget across categories instead of draining the first", async () => {
    // The bug this guards: searching and detailing in one loop spends the
    // whole budget on the first query, so the later categories' design briefs
    // would never once get used.
    const calls = mockPlaces({
      "trade a": ["t1", "t2", "t3", "t4", "t5", "t6"],
      "retail b": ["r1", "r2", "r3", "r4", "r5", "r6"],
      "pro c": ["p1", "p2", "p3", "p4", "p5", "p6"],
    });

    const outcome = await discover(
      [spec("trade a", "trade-service"), spec("retail b", "retail-boutique"), spec("pro c", "professional")],
      "key",
      new Set(),
      6
    );

    expect(outcome.results).toHaveLength(6);
    const byCategory = outcome.results.reduce<Record<string, number>>((acc, r) => {
      acc[r.category] = (acc[r.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(byCategory).toEqual({ "trade-service": 2, "retail-boutique": 2, professional: 2 });
    // All three searches ran even though the budget was small.
    expect(calls.search).toBe(3);
    expect(calls.details).toBe(6);
  });

  it("never pays for details twice when a business matches two queries", async () => {
    const calls = mockPlaces({
      "florist Montreal": ["shared", "f1"],
      "florist NDG Montreal": ["shared", "f2"],
    });

    const outcome = await discover(
      [spec("florist Montreal", "retail-boutique"), spec("florist NDG Montreal", "retail-boutique")],
      "key",
      new Set(),
      10
    );

    expect(calls.details).toBe(3);
    expect(outcome.results.map((r) => r.placeId).sort()).toEqual(["f1", "f2", "shared"]);
    expect(outcome.skippedAlreadySeen).toBe(1);
  });

  it("respects the details ceiling", async () => {
    const calls = mockPlaces({ q: ["a", "b", "c", "d", "e"] });
    await discover([spec("q", "trade-service")], "key", new Set(), 2);
    expect(calls.details).toBe(2);
  });

  it("skips places seen in an earlier run without spending a details call", async () => {
    const calls = mockPlaces({ q: ["old1", "old2", "new1"] });
    const outcome = await discover([spec("q", "trade-service")], "key", new Set(["old1", "old2"]), 10);
    expect(calls.details).toBe(1);
    expect(outcome.results[0].placeId).toBe("new1");
    expect(outcome.skippedAlreadySeen).toBe(2);
  });

  it("caps stored photo references at three", async () => {
    mockPlaces({ q: ["a"] });
    const outcome = await discover([spec("q", "trade-service")], "key", new Set(), 1);
    expect(outcome.results[0].photoRefs).toHaveLength(3);
  });

  it("keeps going when one search fails", async () => {
    const errors: string[] = [];
    let call = 0;
    global.fetch = vi.fn(async (url: any, init: any) => {
      const href = String(url);
      if (href.includes(":searchText")) {
        call++;
        if (call === 1) return { ok: false, status: 429, text: async () => "rate limited", json: async () => ({}) } as any;
        return {
          ok: true, status: 200, text: async () => "",
          json: async () => ({ places: [{ id: "ok1", displayName: { text: "B" }, businessStatus: "OPERATIONAL" }] }),
        } as any;
      }
      return {
        ok: true, status: 200, text: async () => "",
        json: async () => ({ id: "ok1", displayName: { text: "B" }, photos: [] }),
      } as any;
    }) as any;

    const outcome = await discover(
      [spec("fails", "trade-service"), spec("works", "professional")],
      "key",
      new Set(),
      5,
      (_s, e) => errors.push(e.message)
    );

    expect(errors[0]).toMatch(/429/);
    expect(outcome.results).toHaveLength(1);
  });
});
