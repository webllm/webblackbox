import { describe, expect, it } from "vitest";

import { escapeHtml } from "./html.js";

describe("escapeHtml", () => {
  it("escapes markup-significant characters", () => {
    expect(escapeHtml(`<tag attr="quote">'&`)).toBe(
      "&lt;tag attr=&quot;quote&quot;&gt;&#039;&amp;"
    );
  });

  it("returns untouched plain text", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});
