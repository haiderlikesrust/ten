import { describe, expect, it } from "vitest";
import { cardKey, ccIdentity, certKey, gapPct, normalGrader, titleMatches } from "../src/index";

describe("cert keys", () => {
  it("is grader plus the cert digits, whatever the spelling", () => {
    expect(certKey("PSA", "58712664")).toBe("PSA:58712664");
    expect(certKey("Beckett", "0012-345-678")).toBe("BGS:12345678");
    expect(certKey("Professional Sports Authenticator (PSA)", "58712664")).toBe("PSA:58712664");
  });

  it("refuses a missing grader or a number too short to be a cert", () => {
    expect(certKey(null, "58712664")).toBeNull();
    expect(certKey("PSA", "10")).toBeNull();
    expect(certKey("PSA", null)).toBeNull();
  });

  it("knows the graders under their other names", () => {
    expect(normalGrader("BGS")).toBe("BGS");
    expect(normalGrader("cgc")).toBe("CGC");
    expect(normalGrader("")).toBeNull();
  });
});

describe("reading a Collector Crypt name", () => {
  it("finds year, number, name, grader and grade", () => {
    const id = ccIdentity("2025 #064 Shuckle CGC 10 Pristine Mega Symphonia - M1S - Japanese", "CGC");
    expect(id).toMatchObject({ year: 2025, number: "64", main: "shuckle", grader: "CGC", grade: 10, japanese: true });
    expect(cardKey(id)).toBe("shuckle|64|jp|CGC|10");
  });

  it("skips the words every card shares", () => {
    expect(ccIdentity("2016 #XY122 Full Art/Blastoise EX PSA 6 XY Black Star Promo", "PSA")).toMatchObject({ number: "XY122", main: "blastoise", grade: 6, japanese: false });
    expect(ccIdentity("2000 #61 Mankey 1st Edition PSA 9 Rocket", "PSA").main).toBe("mankey");
  });

  it("takes a half grade", () => {
    expect(ccIdentity("2025 #156 Serperior ex CGC 9.5 Black Bolt - BLK EN - English", "CGC").grade).toBe(9.5);
  });

  it("finds the name when it comes before the number", () => {
    const id = ccIdentity("2026 Pokemon Mega Evolution Promo First Partner Illustration Full Art Squirtle #39 CGC 9.5 MINT+", "CGC", 9.5);
    expect(id).toMatchObject({ number: "39", main: "squirtle", grade: 9.5 });
  });

  it("has no card key without a card number", () => {
    expect(cardKey(ccIdentity("2026 #NA One Piece PSA 10 Shueisha Summer Comics Fair", "PSA"))).toBeNull();
  });
});

describe("matching a title elsewhere", () => {
  const shuckle = ccIdentity("2025 #064 Shuckle CGC 10 Pristine Mega Symphonia - M1S - Japanese", "CGC");
  const salamence = ccIdentity("2003 #19 Salamence PSA 8 EX Dragon", "PSA");

  it("matches the same card in the same grade", () => {
    expect(titleMatches(shuckle, "CGC 10 PRISTINE Shuckle 064/063 M1S Mega Symphonia Japanese Pokemon")).toBe(true);
    expect(titleMatches(salamence, "2003 Pokemon EX Dragon Salamence #19 Holo Rare PSA 8 NM-MT")).toBe(true);
  });

  it("refuses another grade or grader", () => {
    expect(titleMatches(salamence, "2003 Pokemon EX Dragon Salamence #19 Holo PSA 9 MINT")).toBe(false);
    expect(titleMatches(salamence, "2003 Pokemon EX Dragon Salamence #19 Holo CGC 8")).toBe(false);
  });

  it("refuses another card number, even one that only starts the same", () => {
    expect(titleMatches(salamence, "2003 Pokemon EX Dragon Salamence #190 PSA 8")).toBe(false);
    expect(titleMatches(salamence, "Salamence ex 97/97 EX Dragon PSA 8")).toBe(false);
  });

  it("does not read the grade or the year as the card number", () => {
    const ten = ccIdentity("2024 #10 Pikachu PSA 10 Promo", "PSA");
    expect(titleMatches(ten, "2024 Pikachu Promo PSA 10 GEM MINT")).toBe(false);
    expect(titleMatches(ten, "2024 Pikachu #010 Promo PSA 10 GEM MINT")).toBe(true);
  });

  it("keeps Japanese and English apart", () => {
    expect(titleMatches(shuckle, "CGC 10 Pristine Shuckle 064 Mega Evolution English")).toBe(false);
    expect(titleMatches(salamence, "Salamence #19 EX Dragon Japanese PSA 8")).toBe(false);
  });

  it("trusts the listing's own grader and grade fields over its title", () => {
    expect(titleMatches(salamence, "Salamence #19 EX Dragon slab", { grader: "Professional Sports Authenticator (PSA)", grade: 8 })).toBe(true);
  });
});

describe("price gap", () => {
  it("is how much cheaper Collector Crypt is than elsewhere", () => {
    expect(gapPct(80, 100)).toBe(20);
    expect(gapPct(120, 100)).toBe(-20);
    expect(gapPct(80, null)).toBeNull();
  });
});
