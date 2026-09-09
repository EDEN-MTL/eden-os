import { afterEach, describe, expect, it, vi } from "vitest";

const checkin = vi.hoisted(() => ({
  getCheckinData: vi.fn(),
  updateCheckinItem: vi.fn(),
  renderCheckinPage: vi.fn(() => "<html>page</html>"),
}));
vi.mock("../agents/scout/checkin", () => checkin);

import { getCheckinDataHandler, getCheckinPage, postCheckinItem } from "./checkin-api";

afterEach(() => vi.clearAllMocks());

function fakeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
}

describe("getCheckinPage", () => {
  it("always sends the HTML shell, regardless of the token", () => {
    const res = fakeRes();
    getCheckinPage({ params: { token: "anything" } } as any, res);
    expect(res.type).toHaveBeenCalledWith("html");
    expect(res.send).toHaveBeenCalledWith("<html>page</html>");
  });
});

describe("getCheckinDataHandler", () => {
  it("responds 404 for a token that resolves to no data", async () => {
    checkin.getCheckinData.mockResolvedValueOnce(null);
    const res = fakeRes();

    await getCheckinDataHandler({ params: { token: "bad" } } as any, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Not found" });
  });

  it("responds with the data as JSON for a valid token", async () => {
    checkin.getCheckinData.mockResolvedValueOnce({ clientName: "3 Percent East Coast" });
    const res = fakeRes();

    await getCheckinDataHandler({ params: { token: "good" } } as any, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ clientName: "3 Percent East Coast" });
  });
});

describe("postCheckinItem", () => {
  it("responds 400 when the body has no checkboxes object", async () => {
    const res = fakeRes();

    await postCheckinItem({ params: { token: "t", ghlEventId: "e" }, body: { field: "showed_up" } } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(checkin.updateCheckinItem).not.toHaveBeenCalled();
  });

  it("responds 400 when checkboxes is an empty object", async () => {
    const res = fakeRes();

    await postCheckinItem({ params: { token: "t", ghlEventId: "e" }, body: { checkboxes: {} } } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(checkin.updateCheckinItem).not.toHaveBeenCalled();
  });

  it("responds 400 when a checkboxes value isn't a boolean", async () => {
    const res = fakeRes();

    await postCheckinItem(
      { params: { token: "t", ghlEventId: "e" }, body: { checkboxes: { showed_up: "yes" } } } as any,
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(checkin.updateCheckinItem).not.toHaveBeenCalled();
  });

  it("responds 404 when the token doesn't resolve", async () => {
    checkin.updateCheckinItem.mockResolvedValueOnce("invalid-token");
    const res = fakeRes();

    await postCheckinItem(
      { params: { token: "bad", ghlEventId: "e" }, body: { checkboxes: { showed_up: true } } } as any,
      res
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("responds 400 when a field isn't one of the known checkboxes", async () => {
    checkin.updateCheckinItem.mockResolvedValueOnce("invalid-field");
    const res = fakeRes();

    await postCheckinItem(
      { params: { token: "t", ghlEventId: "e" }, body: { checkboxes: { not_real: true } } } as any,
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid field" });
  });

  it("responds ok on a successful update, passing the whole checkboxes object through", async () => {
    checkin.updateCheckinItem.mockResolvedValueOnce("ok");
    const res = fakeRes();

    await postCheckinItem(
      {
        params: { token: "t", ghlEventId: "e" },
        body: { checkboxes: { showed_up: true, deal_closed: false } },
      } as any,
      res
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(checkin.updateCheckinItem).toHaveBeenCalledWith("t", "e", { showed_up: true, deal_closed: false });
  });
});
