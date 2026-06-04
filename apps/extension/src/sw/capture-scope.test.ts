import { describe, expect, it } from "vitest";

import {
  shouldStopForCaptureScopeOriginChange,
  shouldStopForEnterpriseOriginPolicy
} from "./capture-scope.js";

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

  it("stops tab-scoped captures when enterprise policy rejects the next origin", () => {
    expect(
      shouldStopForEnterpriseOriginPolicy({
        nextOrigin: "https://blocked.example",
        isEnterpriseOriginAllowed: (origin) => origin !== "https://blocked.example"
      })
    ).toBe(true);
  });

  it("continues tab-scoped captures when enterprise policy allows the next origin", () => {
    expect(
      shouldStopForEnterpriseOriginPolicy({
        nextOrigin: "https://app.example",
        isEnterpriseOriginAllowed: (origin) => origin === "https://app.example"
      })
    ).toBe(false);
  });

  it("keeps tab-scoped captures active on opaque navigations for enterprise policy", () => {
    expect(
      shouldStopForEnterpriseOriginPolicy({
        nextOrigin: null,
        isEnterpriseOriginAllowed: () => false
      })
    ).toBe(false);
  });
});
