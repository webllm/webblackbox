import type {
  FreezeReason,
  RecorderConfig,
  SessionMetadata,
  WebBlackboxEvent,
  WebBlackboxEventType
} from "@webblackbox/protocol";

export type RecorderSource = "cdp" | "content" | "system";

export type RawRecorderEvent = {
  source: RecorderSource;
  rawType: string;
  tabId: number;
  sid: string;
  t: number;
  mono: number;
  nav?: string;
  frame?: string;
  targetId?: string;
  cdpSessionId?: string;
  payload: unknown;
};

export type RecorderIngestResult = {
  event?: WebBlackboxEvent;
  freezeReason?: FreezeReason;
};

export type EventNormalizer = {
  normalize(input: RawRecorderEvent): {
    eventType: WebBlackboxEventType;
    payload: unknown;
  } | null;
};

export type RecorderState = {
  config: RecorderConfig;
  session: SessionMetadata;
  recentNetworkFailures: number[];
};
