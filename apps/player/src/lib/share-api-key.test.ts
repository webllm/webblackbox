/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import {
  bindShareApiKeyInputToTargetOrigin,
  getShareServerApiKeyForBaseUrl,
  setShareServerApiKeyForBaseUrl
} from "./share-api-key.js";

describe("share API key memory", () => {
  it("keeps keys isolated by normalized origin", () => {
    const keys: Record<string, string> = {};
    setShareServerApiKeyForBaseUrl(keys, "https://share-a.example/path", " key-a ");
    setShareServerApiKeyForBaseUrl(keys, "https://share-b.example", "key-b");

    expect(getShareServerApiKeyForBaseUrl(keys, "https://share-a.example/other")).toBe("key-a");
    expect(getShareServerApiKeyForBaseUrl(keys, "https://share-b.example")).toBe("key-b");
  });

  it("replaces an edited key when the target origin changes", () => {
    const sourceInput = document.createElement("input");
    const apiKeyInput = document.createElement("input");
    sourceInput.value = "https://share-a.example/share/one";
    const keys = {
      "https://share-a.example": "key-a",
      "https://share-b.example": "key-b"
    };
    const detach = bindShareApiKeyInputToTargetOrigin(
      sourceInput,
      apiKeyInput,
      (value) => value,
      (baseUrl) => getShareServerApiKeyForBaseUrl(keys, baseUrl)
    );

    expect(apiKeyInput.value).toBe("key-a");
    apiKeyInput.value = "unsent-edited-key-a";
    apiKeyInput.dispatchEvent(new Event("input"));
    sourceInput.value = "https://share-b.example/share/two";
    sourceInput.dispatchEvent(new Event("input"));

    expect(apiKeyInput.value).toBe("key-b");
    detach();
  });

  it("preserves edits while the target origin remains unchanged", () => {
    const sourceInput = document.createElement("input");
    const apiKeyInput = document.createElement("input");
    sourceInput.value = "https://share.example/share/one";
    const detach = bindShareApiKeyInputToTargetOrigin(
      sourceInput,
      apiKeyInput,
      (value) => value,
      () => "stored-key"
    );

    apiKeyInput.value = "edited-key";
    sourceInput.value = "https://share.example/share/two";
    sourceInput.dispatchEvent(new Event("input"));

    expect(apiKeyInput.value).toBe("edited-key");
    detach();
  });
});
