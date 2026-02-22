# @webblackbox/cdp-router

Chrome DevTools Protocol (CDP) routing layer for WebBlackbox. Manages debugger connections, target tracking, and CDP command execution for the Chrome extension.

## Overview

- **CdpRouter** — High-level interface for managing CDP sessions and sending commands
- **DefaultCdpRouter** — Full implementation with multi-target tracking (tabs, iframes, workers)
- **Transport Layer** — Abstraction over Chrome's `chrome.debugger` API
- **Auto-Attach** — Automatic attachment to child targets (iframes, workers, service workers)

## Usage

### Creating a Router

```typescript
import { createCdpRouter, createChromeDebuggerTransport } from "@webblackbox/cdp-router";

const transport = createChromeDebuggerTransport();
const router = createCdpRouter(transport);
```

### Attaching to a Tab

```typescript
// Attach debugger to tab
await router.attach(tabId, "1.3");

// Enable baseline CDP domains (Network, Runtime, Log, Page)
await router.enableBaseline(tabId);

// Enable auto-attach for child targets (iframes, workers)
await router.enableAutoAttach(tabId, {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true
});
```

### Sending CDP Commands

```typescript
// Send CDP command to main target
const result = await router.send<ResponseType>({ tabId }, "Network.getResponseBody", {
  requestId: "12345"
});

// Send CDP command to child target (iframe, worker)
const childResult = await router.send<ResponseType>(
  { tabId, sessionId: "child-session-id" },
  "Runtime.evaluate",
  { expression: "document.title" }
);
```

### Receiving Events

```typescript
// Listen for CDP events
const unsubscribe = router.onEvent((event) => {
  console.log(event.tabId);
  console.log(event.sessionId); // undefined for main target
  console.log(event.method); // "Network.requestWillBeSent", etc.
  console.log(event.params); // CDP event parameters
});

// Listen for detach events
const unsubDetach = router.onDetach((info) => {
  console.log(info.tabId);
  console.log(info.reason); // "target_closed", etc.
});
```

### Target Management

```typescript
// Get all attached targets for a tab
const targets = router.getAttachedTargets(tabId);

for (const target of targets) {
  console.log(target.tabId);
  console.log(target.sessionId); // CDP session ID (for child targets)
  console.log(target.targetId); // Target ID
  console.log(target.frameId); // Frame ID
  console.log(target.targetType); // "page", "iframe", "worker", "service_worker"
  console.log(target.url); // Target URL
}
```

### Detaching and Cleanup

```typescript
// Detach from a specific tab
await router.detach(tabId);

// Clean up all connections
router.dispose();
```

## API Reference

### CdpRouter Interface

```typescript
interface CdpRouter {
  attach(tabId: number, protocolVersion?: string): Promise<void>;
  detach(tabId: number): Promise<void>;
  send<T>(target: Debuggee, method: string, params?: object): Promise<T>;
  enableBaseline(tabId: number, sessionId?: string): Promise<void>;
  enableAutoAttach(tabId: number, options?: AutoAttachOptions, sessionId?: string): Promise<void>;
  getAttachedTargets(tabId: number): RouterAttachedTarget[];
  onEvent(callback: CdpEventHandler): () => void;
  onDetach(callback: CdpDetachHandler): () => void;
  dispose(): void;
}
```

### Types

```typescript
type DebuggerRoot = { tabId: number };
type DebuggerChild = { tabId: number; sessionId: string };
type Debuggee = DebuggerRoot | DebuggerChild;

type RawCdpEvent = {
  tabId: number;
  sessionId?: string;
  method: string;
  params?: object;
};

type DetachInfo = {
  tabId: number;
  reason: string;
};

type RouterAttachedTarget = {
  tabId: number;
  sessionId?: string;
  targetId?: string;
  frameId?: string;
  targetType?: string;
  url?: string;
};

type AutoAttachOptions = {
  autoAttach: boolean;
  waitForDebuggerOnStart: boolean;
  flatten: boolean;
  filter?: object;
};
```

### Baseline Domains

When `enableBaseline()` is called, the following CDP domains are enabled:

- **Network.enable** — HTTP request/response monitoring
- **Runtime.enable** — JavaScript runtime events (exceptions, console)
- **Log.enable** — Browser log entries
- **Page.enable** — Page lifecycle events (navigation, DOM)

### Transport Interface

```typescript
interface DebuggerTransport {
  attach(debuggee: object, version: string): Promise<void>;
  detach(debuggee: object): Promise<void>;
  sendCommand<T>(debuggee: object, method: string, params?: object): Promise<T>;
  addEventListener(handler: CdpEventHandler): () => void;
  addDetachListener(handler: CdpDetachHandler): () => void;
}
```
