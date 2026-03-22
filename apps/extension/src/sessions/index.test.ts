// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PortMessageHandler = (message: unknown) => void;

class FakePort {
  readonly postMessage = vi.fn();
  private readonly messageHandlers = new Set<PortMessageHandler>();

  readonly onMessage = {
    addListener: (handler: PortMessageHandler): void => {
      this.messageHandlers.add(handler);
    },
    removeListener: (handler: PortMessageHandler): void => {
      this.messageHandlers.delete(handler);
    }
  };

  readonly onDisconnect = {
    addListener: (): void => {
      void 0;
    },
    removeListener: (): void => {
      void 0;
    }
  };

  emit(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}

function installChromeStub(port: FakePort): void {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: {
        connect: vi.fn(() => port)
      }
    }
  });
}

async function flushSessions(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function importSessionsModule(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flushSessions();
}

describe("sessions page rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="sessions-root"></main>`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
  });

  it("renders stored note and tag text without turning them into DOM", async () => {
    const port = new FakePort();
    installChromeStub(port);

    await importSessionsModule();

    const hostileText = `</textarea><button id="pwned">x</button>`;
    port.emit({
      kind: "sw.session-list",
      sessions: [
        {
          sid: "sid-1",
          tabId: 7,
          mode: "lite",
          startedAt: Date.now(),
          active: true,
          note: hostileText,
          tags: [hostileText]
        }
      ]
    });
    await flushSessions();

    const noteInput = document.querySelector<HTMLTextAreaElement>("[data-annotate-note]");
    const tagInput = document.querySelector<HTMLInputElement>("[data-annotate-tags]");
    const noteText = document.querySelector<HTMLElement>(".wb-session-card__note");
    const tagChip = document.querySelector<HTMLElement>(".wb-chip--tag");

    expect(noteInput?.value).toBe(hostileText);
    expect(tagInput?.value).toBe(hostileText);
    expect(noteText?.textContent).toBe(hostileText);
    expect(tagChip?.textContent).toBe(`#${hostileText}`);
    expect(document.getElementById("pwned")).toBeNull();
  });
});
