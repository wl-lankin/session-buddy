import { describe, expect, it } from "vitest";
import { parseLink } from "./markdown";

describe("parseLink", () => {
  it("reads a named link", () => {
    expect(parseLink("[docs](https://example.com/a?b=1)")).toEqual({ text: "docs", url: "https://example.com/a?b=1", rest: "" });
  });

  it("leaves sentence punctuation out of a bare URL", () => {
    expect(parseLink("https://example.com/x.")).toEqual({ text: "https://example.com/x", url: "https://example.com/x", rest: "." });
  });

  it("never accepts other schemes", () => {
    expect(parseLink("javascript:alert(1)")).toBeNull();
    expect(parseLink("[x](javascript:alert(1))")).toBeNull();
    expect(parseLink("file:///etc/passwd")).toBeNull();
    expect(parseLink("plain text")).toBeNull();
  });
});
