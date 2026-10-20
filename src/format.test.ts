import { describe, expect, it } from "vitest";
import { title } from "./format";

describe("title", () => {
  it("title-cases registry addresses", () => {
    expect(title("BLK 1 KNOWN STREET")).toBe("Blk 1 Known Street");
  });

  it("keeps block letters capitalised", () => {
    expect(title("BLK 347A ANG MO KIO AVENUE 3")).toBe("Blk 347A Ang Mo Kio Avenue 3");
    expect(title("BLK 223/226/226A-226D ANG MO KIO STREET 22")).toBe("Blk 223/226/226A-226D Ang Mo Kio Street 22");
    expect(title("BLK 700B/ 700C ANG MO KIO AVENUE 3/6")).toBe("Blk 700B/ 700C Ang Mo Kio Avenue 3/6");
  });

  it("title-cases carpark types", () => {
    expect(title("MULTI-STOREY CAR PARK")).toBe("Multi-Storey Car Park");
  });
});
