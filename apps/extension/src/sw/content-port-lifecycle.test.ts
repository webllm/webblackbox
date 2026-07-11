import { describe, expect, it } from "vitest";

import { ContentDocumentAuthorization } from "./content-document-authorization.js";
import { disconnectContentPort } from "./content-port-lifecycle.js";

const TAB_ID = 7;

describe("disconnectContentPort", () => {
  it("releases a top-frame port without reopening document authorization bootstrap", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const topUrl = "https://app.example/dashboard";
    const topSender = {
      tabId: TAB_ID,
      frameId: 0,
      documentId: "top-document",
      url: topUrl
    } as const;
    authorization.reset({ url: topUrl });
    authorization.authorize(topSender);
    const port = { sender: topSender };
    const connectedPorts = new Set([port]);

    disconnectContentPort(connectedPorts, port);

    expect(connectedPorts.has(port)).toBe(false);
    expect(authorization.get(0)).toEqual({
      frameId: 0,
      documentId: "top-document",
      url: topUrl
    });
    expect(authorization.matchesSender(topSender)).toBe(true);
  });

  it("keeps child authorization alive when its transient port disconnects", () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const childSender = {
      tabId: TAB_ID,
      frameId: 4,
      documentId: "child-document",
      url: "https://widgets.example/embed"
    } as const;
    authorization.authorize(childSender);
    const port = { sender: childSender };
    const connectedPorts = new Set([port]);

    disconnectContentPort(connectedPorts, port);

    expect(connectedPorts.has(port)).toBe(false);
    expect(authorization.matchesSender(childSender)).toBe(true);
  });

  it("does not let a stale port disconnect affect its frame's replacement document", async () => {
    const authorization = new ContentDocumentAuthorization(TAB_ID);
    const oldSender = {
      tabId: TAB_ID,
      frameId: 5,
      documentId: "old-document",
      url: "https://widgets.example/old"
    } as const;
    authorization.authorize(oldSender);
    const oldPort = { sender: oldSender };
    const connectedPorts = new Set([oldPort]);

    const replacementUrl = "https://widgets.example/new";
    const prepared = await authorization.prepareCommittedNavigation(
      {
        tabId: TAB_ID,
        frameId: 5,
        documentId: "new-document",
        url: replacementUrl
      },
      () => true
    );
    expect(prepared.prepared).toBe(true);
    authorization.completePendingInjection(5, "new-document");
    authorization.authorize({
      tabId: TAB_ID,
      frameId: 5,
      documentId: "new-document",
      url: replacementUrl
    });

    disconnectContentPort(connectedPorts, oldPort);

    expect(connectedPorts.has(oldPort)).toBe(false);
    expect(authorization.get(5)).toEqual({
      frameId: 5,
      documentId: "new-document",
      url: replacementUrl
    });
    expect(authorization.matchesSender(oldSender)).toBe(false);
  });
});
