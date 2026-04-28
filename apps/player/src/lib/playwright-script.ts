import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { asFiniteNumber, asRecord, asString } from "./parsing.js";

export type PlayerPlaywrightScriptOptions = {
  name?: string;
  maxActions?: number;
  includeHarReplay?: boolean;
  startUrl?: string;
};

export function generatePlaywrightScriptFromEvents(
  events: WebBlackboxEvent[],
  options: PlayerPlaywrightScriptOptions = {}
): string {
  const name = options.name ?? "replay-from-webblackbox";
  const maxActions = Math.max(1, options.maxActions ?? 40);
  const includeHarReplay = options.includeHarReplay ?? true;
  const startUrl = options.startUrl ?? "about:blank";
  const actions = events
    .filter(
      (event) =>
        event.type.startsWith("user.") || event.type === "nav.commit" || event.type === "nav.hash"
    )
    .slice(0, maxActions);

  const lines = [
    "import { test } from '@playwright/test';",
    "",
    `test('${name}', async ({ browser }) => {`,
    "  const context = await browser.newContext();",
    includeHarReplay
      ? "  await context.routeFromHAR('./session.har', { notFound: 'fallback' });"
      : "  // HAR replay disabled.",
    "  const page = await context.newPage();",
    `  await page.goto(${JSON.stringify(startUrl)});`
  ];

  for (const action of actions) {
    lines.push(...toPlaywrightLines(action));
  }

  lines.push("  await context.close();", "});");

  return lines.join("\n");
}

function toPlaywrightLines(event: WebBlackboxEvent): string[] {
  if (event.type === "nav.commit" || event.type === "nav.hash") {
    const payload = asRecord(event.data);
    const url = asString(payload?.url);
    return url ? [`  await page.goto(${JSON.stringify(url)});`] : [];
  }

  if (event.type === "user.click" || event.type === "user.dblclick") {
    const selector = readSelector(event);

    if (!selector) {
      return [`  // ${event.type} skipped (no selector)`];
    }

    const method = event.type === "user.dblclick" ? "dblclick" : "click";
    return [`  await page.${method}(${JSON.stringify(selector)});`];
  }

  if (event.type === "user.input") {
    const selector = readSelector(event);
    const payload = asRecord(event.data);
    const value = asString(payload?.value);

    if (!selector) {
      return [`  // input skipped (no selector)`];
    }

    if (!value || value === "[MASKED]") {
      return [`  // input on ${selector} was masked in capture`];
    }

    return [`  await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)});`];
  }

  if (event.type === "user.scroll") {
    const payload = asRecord(event.data);
    const x = asFiniteNumber(payload?.scrollX) ?? 0;
    const y = asFiniteNumber(payload?.scrollY) ?? 0;

    return [`  await page.evaluate(([x, y]) => window.scrollTo(x, y), [${x}, ${y}] as const);`];
  }

  if (event.type === "user.keydown") {
    const payload = asRecord(event.data);
    const key = asString(payload?.key);

    if (!key) {
      return [];
    }

    return [`  await page.keyboard.press(${JSON.stringify(key)});`];
  }

  if (event.type === "user.marker") {
    return ["  // Marker captured during session"];
  }

  return [];
}

function readSelector(event: WebBlackboxEvent): string | null {
  const payload = asRecord(event.data);
  const target = asRecord(payload?.target);
  const selector = asString(target?.selector);

  if (!selector || selector === "unknown") {
    return null;
  }

  return selector;
}
