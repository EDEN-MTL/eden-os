import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineNotProvisionedError, resolvePipeline, upsertProspectContact } from "./sync";

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
// typos — see the note on QuarryStage in types.ts. Confirmed against GHL's
// Pipelines tab 2026-09-06 — "Screenshot Sent"/"Site Sent" no longer exist,
// collapsed into "Initial Email Sent".
const WEBSITE_STAGES = [
  "New Lead",
  "Initial Email Sent",
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
    expect(resolved.stageIds["Initial Email Sent"]).toBe("stage_1");
    expect(resolved.stageIds["Replied Interest"]).toBe("stage_2");
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
    mockPipelines([websitePipeline(["New Lead", "Replied Interest", "Closed Won"])]);

    await expect(
      resolvePipeline("Website Offer Pipeline", WEBSITE_STAGES, "loc_1", "key")
    ).rejects.toThrow(/Initial Email Sent/);
  });

  it("does not fuzzy-match a stage that differs by a trailing space", async () => {
    // GHL stage names carry stray whitespace and emoji routinely. A tolerant
    // match would bind to the wrong stage and misfile leads silently.
    mockPipelines([
      websitePipeline([
        "New Lead",
        "Initial Email Sent ",
        "Replied Interest",
        "Call Booked",
        "Closed Won",
        "Lost/Nurture",
      ]),
    ]);

    await expect(
      resolvePipeline("Website Offer Pipeline", WEBSITE_STAGES, "loc_1", "key")
    ).rejects.toThrow(/Initial Email Sent/);
  });
});

describe("upsertProspectContact", () => {
  const BASE_INPUT = {
    name: "Biz",
    phone: "+15145550100",
    email: null,
    website: null,
    category: null as null,
    previewUrl: null,
    previewImageUrl: null,
    outdatedScore: null,
  };

  function mockContacts(opts: { existing?: any; captured: { body?: any; method?: string }[] }) {
    global.fetch = vi.fn(async (url: any, init: any) => {
      const href = String(url);
      opts.captured.push({ body: init?.body ? JSON.parse(init.body) : undefined, method: init?.method });
      if (href.includes("/contacts/search")) {
        return {
          ok: true, status: 200, text: async () => "",
          json: async () => ({ contacts: opts.existing ? [opts.existing] : [] }),
        } as any;
      }
      return {
        ok: true, status: 200, text: async () => "",
        json: async () => ({ contact: { id: "new_c1" } }),
      } as any;
    }) as any;
  }

  it("includes the business's existing website on a newly created contact", async () => {
    const captured: { body?: any; method?: string }[] = [];
    mockContacts({ captured });

    await upsertProspectContact(
      { ...BASE_INPUT, website: "https://oldsite.example.com" },
      "loc_1",
      "key"
    );

    const createCall = captured.find((c) => c.method === "POST");
    expect(createCall!.body.website).toBe("https://oldsite.example.com");
  });

  it("omits website entirely on create rather than sending an empty value when the lead has none", async () => {
    const captured: { body?: any; method?: string }[] = [];
    mockContacts({ captured });

    await upsertProspectContact({ ...BASE_INPUT, website: null }, "loc_1", "key");

    const createCall = captured.find((c) => c.method === "POST");
    expect(createCall!.body).not.toHaveProperty("website");
  });

  it("also refreshes the website on an already-existing contact, alongside tags", async () => {
    const captured: { body?: any; method?: string }[] = [];
    mockContacts({ existing: { id: "existing_c1" }, captured });

    await upsertProspectContact(
      { ...BASE_INPUT, website: "https://oldsite.example.com" },
      "loc_1",
      "key"
    );

    const updateCall = captured.find((c) => c.method === "PUT");
    expect(updateCall!.body).toMatchObject({ website: "https://oldsite.example.com", tags: ["quarry"] });
  });
});
