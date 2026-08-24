import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listContactsPaginated, listOpportunitiesPaginated } from "./index";

/**
 * Regression tests for a real production bug: GHL's cursor pagination was
 * observed cycling rather than terminating — paginating one live pipeline
 * yielded 3,000 opportunities that were only 207 unique records, looping
 * forever and hanging the sync without ever writing a row.
 *
 * The original guard only compared the LAST item of a page against the
 * previous cursor, which a cycling page slips past.
 */

const originalFetch = global.fetch;

function mockPages(key: "contacts" | "opportunities", pages: any[][]) {
  let call = 0;
  global.fetch = vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ [key]: page }),
      text: async () => "",
    } as any;
  }) as any;
}

const contact = (id: string) => ({ id, dateAdded: "2026-01-01T00:00:00Z" });
const opp = (id: string) => ({ id, updatedAt: "2026-01-01T00:00:00Z" });

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

beforeEach(() => {
  process.env.GHL_API_KEY = "test-key";
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("listOpportunitiesPaginated", () => {
  it("terminates when the server cycles the same page forever", async () => {
    // Every request returns the identical full page — the exact live failure.
    const page = Array.from({ length: 100 }, (_, i) => opp(`o${i}`));
    mockPages("opportunities", [page]);

    const result = await collect(listOpportunitiesPaginated("loc", { limit: 100 }));

    expect(result).toHaveLength(100);
    expect(new Set(result.map((o: any) => o.id)).size).toBe(100);
  });

  it("never yields the same record twice across overlapping pages", async () => {
    const p1 = Array.from({ length: 100 }, (_, i) => opp(`o${i}`));
    // Second page overlaps by 50 — only the 50 genuinely new ones should surface.
    const p2 = [...p1.slice(50), ...Array.from({ length: 50 }, (_, i) => opp(`n${i}`))];
    mockPages("opportunities", [p1, p2, p2]);

    const result = await collect(listOpportunitiesPaginated("loc", { limit: 100 }));
    const ids = result.map((o: any) => o.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(150);
  });

  it("stops normally on a short final page", async () => {
    mockPages("opportunities", [Array.from({ length: 40 }, (_, i) => opp(`o${i}`))]);
    expect(await collect(listOpportunitiesPaginated("loc", { limit: 100 }))).toHaveLength(40);
  });

  it("stops on an empty first page", async () => {
    mockPages("opportunities", [[]]);
    expect(await collect(listOpportunitiesPaginated("loc", { limit: 100 }))).toHaveLength(0);
  });
});

describe("listContactsPaginated", () => {
  it("terminates when the server cycles the same page forever", async () => {
    const page = Array.from({ length: 100 }, (_, i) => contact(`c${i}`));
    mockPages("contacts", [page]);

    const result = await collect(listContactsPaginated("loc", { limit: 100 }));

    expect(result).toHaveLength(100);
    expect(new Set(result.map((c: any) => c.id)).size).toBe(100);
  });

  it("does not send startAfter when the timestamp is unparseable", async () => {
    // A bad date previously produced startAfter=NaN, which the server can
    // reject or ignore — either way the cursor stops advancing.
    const p1 = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, dateAdded: "not-a-date" }));
    mockPages("contacts", [p1, []]);

    await collect(listContactsPaginated("loc", { limit: 100 }));

    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("NaN"))).toBe(false);
  });
});
