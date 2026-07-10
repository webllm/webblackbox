import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { DiagnosticCategory, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";

import { generatePlaywrightScriptFromEvents } from "./playwright-script.js";

function event(
  id: string,
  mono: number,
  type: WebBlackboxEvent["type"],
  data: WebBlackboxEvent["data"]
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-test",
    tab: 1,
    t: mono,
    mono,
    type,
    id,
    data
  };
}

function expectValidTypeScript(source: string): void {
  const result = transpileModule(source, {
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022
    },
    reportDiagnostics: true
  });
  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === DiagnosticCategory.Error
  );

  expect(errors).toEqual([]);
}

describe("generatePlaywrightScriptFromEvents", () => {
  it("generates Playwright actions from already filtered playback events", () => {
    const script = generatePlaywrightScriptFromEvents(
      [
        event("E-1", 100, "user.click", {
          target: {
            selector: "button.save"
          }
        }),
        event("E-2", 200, "user.input", {
          target: {
            selector: "input[name=email]"
          },
          value: "dev@example.test"
        })
      ],
      {
        startUrl: "https://example.test",
        includeHarReplay: false
      }
    );

    expect(script).toContain('await page.goto("https://example.test");');
    expect(script).toContain("HAR replay disabled");
    expect(script).toContain('await page.click("button.save");');
    expect(script).toContain('await page.fill("input[name=email]", "dev@example.test");');
  });

  it("respects maxActions after the caller applies the playback-time range", () => {
    const script = generatePlaywrightScriptFromEvents(
      [
        event("E-1", 1_700_000_000_100, "user.click", {
          target: {
            selector: "button.first"
          }
        }),
        event("E-2", 1_700_000_000_200, "user.click", {
          target: {
            selector: "button.second"
          }
        })
      ],
      {
        maxActions: 1
      }
    );

    expect(script).toContain("button.first");
    expect(script).not.toContain("button.second");
  });

  it("escapes untrusted names and keeps masked selectors inside one comment line", () => {
    const script = generatePlaywrightScriptFromEvents(
      [
        event("E-malicious", 100, "user.input", {
          target: {
            selector: 'input[name=password]\nawait page.goto("https://attacker.invalid")'
          },
          value: "[MASKED]"
        })
      ],
      {
        name: "replay');\nthrow new Error('injected')\u2028//",
        includeHarReplay: false
      }
    );

    expect(script).toContain(`test("replay');\\nthrow new Error('injected')\\u2028//"`);
    expect(script).toContain(
      '// input on input[name=password] await page.goto("https://attacker.invalid") was masked in capture'
    );
    expect(script).not.toContain('\nawait page.goto("https://attacker.invalid")');
    expectValidTypeScript(script);
  });
});
