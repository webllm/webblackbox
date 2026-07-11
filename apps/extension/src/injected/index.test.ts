import { describe, expect, it, vi } from "vitest";

const directHooks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  control: vi.fn()
}));

vi.mock("webblackbox/injected-hooks", () => ({
  bootstrapInjectedLiteCaptureDirect: directHooks.bootstrap,
  controlInjectedLiteCaptureDirect: directHooks.control
}));

import { bootstrap, control } from "./index.js";

describe("direct injected module entry", () => {
  it("only re-exports bootstrap and control without invoking either function", () => {
    expect({ bootstrap, control }).toEqual({
      bootstrap: directHooks.bootstrap,
      control: directHooks.control
    });
    expect(directHooks.bootstrap).not.toHaveBeenCalled();
    expect(directHooks.control).not.toHaveBeenCalled();
  });
});
