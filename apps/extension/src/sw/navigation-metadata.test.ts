import { describe, expect, it } from "vitest";

import { shouldUpdateSessionMetadataFromNavigation } from "./navigation-metadata.js";

describe("navigation-metadata", () => {
  it("accepts root target main-frame navigations", () => {
    expect(
      shouldUpdateSessionMetadataFromNavigation(
        {},
        {
          frame: {
            id: "root",
            url: "https://example.com/dashboard"
          }
        }
      )
    ).toBe(true);
  });

  it("ignores same-target child frame navigations", () => {
    expect(
      shouldUpdateSessionMetadataFromNavigation(
        {},
        {
          frame: {
            id: "child",
            parentId: "root",
            url: "about:srcdoc"
          }
        }
      )
    ).toBe(false);
  });

  it("ignores child CDP target navigations", () => {
    expect(
      shouldUpdateSessionMetadataFromNavigation(
        {
          cdp: "child-session"
        },
        {
          frame: {
            id: "child-root",
            url: "https://third-party.example/frame"
          }
        }
      )
    ).toBe(false);
  });
});
