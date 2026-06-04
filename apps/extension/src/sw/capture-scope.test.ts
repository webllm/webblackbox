import { describe, expect, it } from "vitest";

import { shouldStopForCaptureScopeOriginChange } from "./capture-scope.js";

describe("capture-scope", () => {
  it("honors capture policy origin-change stops outside activeTab builds", () => {
    expect(
      shouldStopForCaptureScopeOriginChange({
        scopeOrigin: "https://app.example",
        nextOrigin: "https://admin.example",
        stopOnOriginChange: true,
        activeTabScopedBuild: false
      })
    ).toBe(true);
  });

  it("continues same-origin navigations", () => {
    expect(
      shouldStopForCaptureScopeOriginChange({
        scopeOrigin: "https://app.example",
        nextOrigin: "https://app.example",
        stopOnOriginChange: true,
        activeTabScopedBuild: true
      })
    ).toBe(false);
  });

  it("keeps tab-scoped captures active when origin-change stops are disabled", () => {
    expect(
      shouldStopForCaptureScopeOriginChange({
        scopeOrigin: "https://app.example",
        nextOrigin: "https://admin.example",
        stopOnOriginChange: false,
        activeTabScopedBuild: true
      })
    ).toBe(false);
  });

  it("keeps tab-scoped captures active on opaque navigations when origin-change stops are disabled", () => {
    expect(
      shouldStopForCaptureScopeOriginChange({
        scopeOrigin: "https://app.example",
        nextOrigin: null,
        stopOnOriginChange: false,
        activeTabScopedBuild: true
      })
    ).toBe(false);
  });
});
