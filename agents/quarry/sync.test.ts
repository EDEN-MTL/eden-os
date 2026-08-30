import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineNotProvisionedError, resolvePipeline } from "./sync";

/**
 * Pipeline resolution has to fail loudly, because every failure mode here is
 * silent in GHL. A missing pipeline, a renamed stage, or a stage name that
 * differs by a trailing space all end the same way if we guess: opportunities
 * filed into the wrong stage, or into a stage id that no longer exists, with
 * no error from the API. The live location these run against has stages
 * called "Closed 💸" and "🤷‍♂️", which is why matching is exact.
 */

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockPipelines(pipelines: any[]) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ pipelines }),
    text: async () => "",
  })) as any;
}

// Transcribed from the live pipeline, including the names that look like
// typos — see the note on QuarryStage in types.ts.
const WEBSITE_STAGES = [
  "New Lead",
  "Screenshot Sent",
  "Site Sent",
  "Replied Interest",
  "Call Booked",
  "Closed Won",
  "Lost/Nurture",
];

function websitePipeline(stageNames: string[] = WEBSITE_STAGES) {
  return {
    id: "pipe_website",
    name: "Website Offer Pipeline",
    stages: stageNames.map((name, i) => ({ id: `stage_${i}`, name, position: i })),
  };
}

describe("resolvePipeline", () => {
  it("maps every configured stage name to its live id", async () => {
    mockPipelines([websitePipeline()]);

    const resolved = await resolvePipeline(
      "Website Offer Pipeline",
      WEBSITE_STAGES,
      "loc_1",
      "key"
    );

    expect(resolved.pipelineId).toBe("pipe_website");
    expect(resolved.stageIds["Screenshot Sent"]).toBe("stage_1");
    expect(resolved.stageIds["Site Sent"]).toBe("stage_2");
    expect(Object.keys(resolved.stageIds)).toHaveLength(WEBSITE_STAGES.length);
  });

  it("throws with the available pipeline names when the pipeline is absent", async () => {
    // The real location's five pipelines, none of which is ours.
    mockPipelines([
      { id: "a", name: "Cold SMS", stages: [] },
      { id: "b", name: "Montreal Offer Pipeline", stages: [] },
    ]);

    await expect(
      resolvePipeline("Website Offer Pipeline", WEBSITE_STAGES, "loc_1", "key")
    ).rejects.toBeInstanceOf(PipelineNotProvisionedError);

    // The error has to name what DOES exist — otherwise the operator is left
    // guessing whether they typo'd the config or never built the pipeline.
    await expect(
      resolvePipeline("Website Offer Pipeline", WEBSITE_STAGES, "loc_1", "key")
    ).rejects.toThrow(/Cold SMS, Montreal Offer Pipeline/);
  });

  it("names the missing stages when the pipeline exists but is incomplete", async () => {
    mockPipelines([websitePipeline(["New Lead", "Site Sent", "Closed Won"])]);

    await expect(
      resolvePipeline("Website Offer Pipeline", WEBSITE_STAGES, "loc_1", "key")
    ).rejects.toThrow(/Screenshot Sent/);
  });

  it("does not fuzzy-match a stage that differs by a trailing space", async () => {
    // GHL stage names carry stray whitespace and emoji routinely. A tolerant
    // match would bind to the wrong stage and misfile leads silently.
    mockPipelines([
      websitePipeline([
        "New Lead",
        "Screenshot Sent ",
        "Site Sent",
        "Replied Interest",
        "Call Booked",
        "Closed Won",
        "Lost/Nurture",
      ]),
    ]);

    await expect(
      resolvePipeline("Website Offer Pipeline", WEBSITE_STAGES, "loc_1", "key")
    ).rejects.toThrow(/Screenshot Sent/);
  });
});
