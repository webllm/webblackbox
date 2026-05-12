import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { buildPrivacyManifest } from "./privacy.js";

function createEvent(
  id: string,
  data: unknown = {},
  tab = 2_104_634_568,
  type: WebBlackboxEvent["type"] = "network.request"
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-privacy-scan",
    tab,
    t: 1_778_655_646_749,
    mono: 1_778_655_646_749.5,
    type,
    id,
    privacy: {
      category: "network",
      sensitivity: "medium",
      redacted: false
    },
    data
  };
}

describe("privacy scanner", () => {
  it("does not classify browser numeric event metadata as phone numbers", async () => {
    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-tab-id")],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("passed");
    expect(manifest.scanner.findings).toEqual([]);
  });

  it("still scans string payload leaves for phone numbers", async () => {
    const manifest = await buildPrivacyManifest({
      events: [createEvent("E-phone", { message: "Call support at 415-555-0101" })],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("blocked");
    expect(manifest.scanner.findings).toMatchObject([
      {
        kind: "phone",
        path: "event:E-phone",
        matchCount: 1
      }
    ]);
  });

  it("does not scan recorder config policy metadata as captured content", async () => {
    const manifest = await buildPrivacyManifest({
      events: [
        createEvent(
          "E-config",
          {
            redaction: {
              redactHeaders: ["x-api-key"],
              redactBodyPatterns: ["private_key"]
            }
          },
          2_104_634_568,
          "meta.config"
        )
      ],
      blobs: [],
      encrypted: true
    });

    expect(manifest.scanner.status).toBe("passed");
  });
});
