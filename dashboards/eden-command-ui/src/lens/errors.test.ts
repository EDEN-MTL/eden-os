import { describe, expect, it } from "vitest";
import { LensApiError } from "../api";
import { describeError, reportProblem, within } from "./errors";

const good = () => ({
  kpis: { sections: [], period: {}, client: {}, notes: [] },
  series: { points: [] },
  campaigns: { rows: [], totals: {} },
  attribution: { chain: [], deals: [], sources: [], methodology: [], quality: {} },
}) as any;

describe("describeError", () => {
  it("says what to do about a wrong key, a slow answer, a busy server and an unreachable one", () => {
    expect(describeError(new LensApiError("x", 401)).message).toMatch(/access key/);
    expect(describeError(new LensApiError("x", 408)).message).toMatch(/took too long/);
    expect(describeError(new LensApiError("x", 429)).message).toMatch(/Too many requests/);
    expect(describeError(new LensApiError("x", 502)).message).toMatch(/not reachable/);
    expect(describeError(new LensApiError("x", 503)).message).toMatch(/not available yet/);
  });

  it("passes on the server's own sentence for a bad period or an unknown client", () => {
    expect(describeError(new LensApiError("The start date is after the end date.", 400))).toEqual({ message: "The start date is after the end date.", httpStatus: 400 });
    expect(describeError(new LensApiError('No client "x".', 404)).message).toBe('No client "x".');
  });

  it("names the part that failed", async () => {
    const failure = await within("the campaign table", Promise.reject(new LensApiError("boom", 408))).catch((e) => e);
    expect(describeError(failure).message).toMatch(/took too long to answer \(while loading the campaign table\)/);
    const offline = await within("the numbers", Promise.reject(new TypeError("Failed to fetch"))).catch((e) => e);
    expect(describeError(offline).message).toMatch(/Could not reach the reporting service \(while loading the numbers\)/);
  });

  it("shows no internals for a 500 with a stack-like message from somewhere else", () => {
    expect(describeError(new LensApiError("Could not build the report. Try again in a moment.", 500)).message).not.toMatch(/at |\.ts/);
  });

  it("does not call a cancelled request a failure to reach the service", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(describeError(abort).message).toBe("The request was cancelled.");
  });
});

describe("reportProblem", () => {
  it("accepts a complete report", () => expect(reportProblem(good())).toBeNull());

  it("names every part that is missing or the wrong shape", () => {
    const r = good();
    r.series = {};
    r.attribution = { chain: [] };
    r.kpis.sections = "no";
    const problem = reportProblem(r)!;
    expect(problem).toMatch(/the numbers and the trend charts and the attribution/);
    expect(problem).toMatch(/Refresh the page/);
  });

  it("does not throw on nulls", () => {
    expect(reportProblem({ kpis: null, series: null, campaigns: null, attribution: null } as any)).toMatch(/does not understand/);
  });
});
