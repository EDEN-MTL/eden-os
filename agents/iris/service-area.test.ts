import { describe, expect, it } from "vitest";
import { classifyPlace, serviceAreaRule } from "./service-area";
import config from "../../config/clients/3-percent-east-coast.json";

const AREA = config.market.serviceArea;

describe("classifyPlace — 3% Realty's real service-area lists", () => {
  it.each([
    "Paradise. Newfoundland, Labrador.", // the exact answer from the Oct 9 call
    "I'm in Paradise",
    "15 Mullingar drive in Paradise",
    "Mount Pearl",
    "Conception Bay South",
    "CBS",
    "Topsail",
    "Torbay",
    "Portugal Cove-St. Philip's",
    "St. John's",
    "Saint John's, Newfoundland",
    "the Goulds",
    "Kenmount Terrace",
  ])("treats %s as in the metro area", (place) => {
    expect(classifyPlace(place, AREA)).toBe("core");
  });

  it.each(["Holyrood", "Bay Roberts", "Bay Bulls", "Bell Island"])("treats %s as nearby — carry on, an agent confirms", (place) => {
    expect(classifyPlace(place, AREA)).toBe("nearby");
  });

  it.each(["Corner Brook", "Gander", "Halifax, Nova Scotia", "Toronto"])("treats %s as clearly outside", (place) => {
    expect(classifyPlace(place, AREA)).toBe("outside");
  });

  it("never mistakes Saint John, New Brunswick for St. John's", () => {
    expect(classifyPlace("Saint John, New Brunswick", AREA)).toBe("outside");
    expect(classifyPlace("Saint John NB", AREA)).toBe("outside");
  });

  it("says 'unknown' — never 'outside' — for a place it doesn't recognise, or nothing at all", () => {
    expect(classifyPlace("Smallville", AREA)).toBe("unknown");
    expect(classifyPlace("", AREA)).toBe("unknown");
  });

  it("matches whole place names only", () => {
    expect(classifyPlace("Paradiseville", AREA)).toBe("unknown");
  });
});

describe("serviceAreaRule", () => {
  it("falls back to a rule that never assumes a place is outside when no geography is configured", () => {
    const rule = serviceAreaRule("Halifax", undefined, "We only serve Halifax.");

    expect(rule).toContain("never assume it's outside");
    expect(rule).toContain("We only serve Halifax.");
  });
});
