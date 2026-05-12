import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const publicIndexPath = resolve(testDir, "../public/index.html");

describe("player CSP", () => {
  it("allows runtime style positioning without allowing inline scripts", () => {
    const html = readFileSync(publicIndexPath, "utf8");
    const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/u)?.[1] ?? "";

    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
