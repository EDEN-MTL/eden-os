import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../../../shared/db", () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { readEmergencyHoldAll, writeEmergencyHoldAll } from "./settings";

beforeEach(() => {
  queryMock.mockClear();
});

describe("readEmergencyHoldAll", () => {
  it("defaults to true (hold everything) when no row exists yet", async () => {
    // The master kill switch fails safe: a fresh install, or a client with
    // no row for this key, must never be treated as "automation is clear
    // to run" by omission.
    queryMock.mockResolvedValueOnce([]);

    expect(await readEmergencyHoldAll("eden")).toBe(true);
  });

  it.each(["1", "true", "yes", "on", "TRUE", "On"])("treats stored value %j as held", async (value) => {
    queryMock.mockResolvedValueOnce([{ value }]);

    expect(await readEmergencyHoldAll("eden")).toBe(true);
  });

  it.each(["0", "false", "no", "off", "", "unknown"])("treats stored value %j as not held", async (value) => {
    queryMock.mockResolvedValueOnce([{ value }]);

    expect(await readEmergencyHoldAll("eden")).toBe(false);
  });

  it("is read fresh every call, never cached — scopes the query to the given client", async () => {
    queryMock.mockResolvedValueOnce([{ value: "true" }]);

    await readEmergencyHoldAll("matama");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE client_id = \$1 AND key = 'emergency_hold_all'/);
    expect(params).toEqual(["matama"]);
  });
});

describe("writeEmergencyHoldAll", () => {
  it("persists true as the string 'true'", async () => {
    queryMock.mockResolvedValueOnce([]);

    await writeEmergencyHoldAll(true, "eden");

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ad_settings/);
    expect(sql).toMatch(/ON CONFLICT \(client_id, key\) DO UPDATE/);
    expect(params).toEqual(["eden", "true"]);
  });

  it("persists false as the string 'false', not JS's falsy empty string or 0", async () => {
    queryMock.mockResolvedValueOnce([]);

    await writeEmergencyHoldAll(false, "matama");

    expect(queryMock.mock.calls[0][1]).toEqual(["matama", "false"]);
  });

  it("round-trips through readEmergencyHoldAll correctly", async () => {
    queryMock.mockResolvedValueOnce([]); // write
    await writeEmergencyHoldAll(false, "eden");
    const writtenValue = queryMock.mock.calls[0][1][1];

    queryMock.mockResolvedValueOnce([{ value: writtenValue }]); // simulate the row now existing
    expect(await readEmergencyHoldAll("eden")).toBe(false);
  });
});
