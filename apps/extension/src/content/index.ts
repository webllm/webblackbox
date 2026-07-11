import type { CaptureMode, CapturePolicy } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";
import type { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import type { LiteCaptureAgentOptions, LiteCaptureState } from "webblackbox/types";

import { getChromeApi, type MessageSenderLike, type PortLike } from "../shared/chrome-api.js";
import {
  createContentEventBatchId,
  createContentReadyId,
  type ContentActivationId,
  type ContentEventBatchId,
  type ContentReadyId
} from "../shared/content-activation-protocol.js";
import {
  parseMainWorldControllerSeedMessage,
  sameMainWorldControllerCapability,
  type MainWorldControllerHint
} from "../shared/main-world-controller.js";
import {
  PORT_NAMES,
  type ContentPrepareMessage,
  type ContentSameDocumentTransition,
  type ContentStopDrainArtifact,
  type ContentStopDrainDegradationReason
} from "../shared/messages.js";
import { acquireContentBootstrapLease, type ContentBootstrapLease } from "./bootstrap-lease.js";
import { CONTENT_EVENT_FLUSH_CHUNK, resolveContentEventFlushDelay } from "./flush-policy.js";
import {
  captureRecoverableContentEventQueue,
  restoreRecoverableContentEventQueue,
  type RecoverableContentEventQueue
} from "./event-queue-recovery.js";
import {
  isContentMarkerCommand,
  parseContentMainWorldControlResult,
  parseContentControlMessage,
  type ContentControlMessage
} from "./outbound-messages.js";
import { bindContentPageLifecycle } from "./page-lifecycle.js";
import {
  buildContentStopDrainedMessage,
  resolveContentStopDrainContext,
  type ContentStopDrainContext
} from "./stop-drain.js";

type ContentAgentModule = typeof import("./content-agent.js");

type ContentActivationPhase =
  | "prepared"
  | "armed"
  | "active-unbound"
  | "active-bound"
  | "quiescing-unbound"
  | "quiescing-bound"
  | "draining";

type ContentActivation = Readonly<{
  epoch: number;
  readyId: ContentReadyId;
  activationId: ContentActivationId;
  sid: string;
  tabId: number;
  mode: CaptureMode;
  sampling: ContentPrepareMessage["sampling"];
  capturePolicy: CapturePolicy;
  sameDocumentTransition?: ContentSameDocumentTransition;
}> & {
  mainWorldController: MainWorldControllerHint | null;
  documentUrl: string;
  urlRevision: number;
  phase: ContentActivationPhase;
};

type PendingContentEventBatch = {
  batchId: ContentEventBatchId;
  events: RawRecorderEvent[];
  documentUrl: string;
  stopDrainToken?: string;
};

type AwaitingReady = Readonly<{
  epoch: number;
  readyId: ContentReadyId;
  reason: "requested" | "pageshow" | "recovery";
  currentActivationId?: ContentActivationId;
  documentUrl: string;
  mainWorldController: MainWorldControllerHint | null;
  sameDocumentTransition?: ContentSameDocumentTransition;
}>;

const contentBootstrapLease = acquireContentBootstrapLease(globalThis);

if (contentBootstrapLease) {
  bootstrapContentRuntime(contentBootstrapLease);
}

function bootstrapContentRuntime(bootstrapLease: ContentBootstrapLease): void {
  const chromeApi = getChromeApi();
  const keyboardMarkerMessage =
    chromeApi?.i18n?.getMessage?.("contentKeyboardMarker") || "Keyboard marker";
  let activationEpoch = 0;
  let lifecycleVersion = 0;
  let awaitingReady: AwaitingReady | null = null;
  let currentActivation: ContentActivation | null = null;
  let lastActivationHint: ContentActivationId | undefined;
  let lastMainWorldController: MainWorldControllerHint | null = null;
  let contentPort: PortLike | null = null;
  let contentPortBound = false;
  let reconnectTimer = 0;
  let reconnectAttempts = 0;
  let bindFailures = 0;
  let bindAckTimer = 0;
  let armedRetryTimer = 0;
  let readyRetryTimer = 0;
  let captureAgent: LiteCaptureAgent | null = null;
  let captureAgentPromise: Promise<LiteCaptureAgent> | null = null;
  let pendingEvents: RawRecorderEvent[] = [];
  let pendingEventBatch: PendingContentEventBatch | null = null;
  let recoverableEventQueue: RecoverableContentEventQueue | null = null;
  let exactReactivationPending = false;
  let pendingEventFlushTimer = 0;
  let pendingEventFlushDelayMs = Number.POSITIVE_INFINITY;
  let eventBatchAckTimer = 0;
  let stopDrainContext: ContentStopDrainContext | null = null;
  let stopIntentQuiescence: {
    activationId: ContentActivationId;
    promise: Promise<boolean>;
  } | null = null;
  const stopDrainExpectedArtifacts = new Set<ContentStopDrainArtifact>();
  const stopDrainEmittedArtifacts = new Set<ContentStopDrainArtifact>();
  const stopDrainOmittedArtifacts = new Set<ContentStopDrainArtifact>();
  const stopDrainDegradationReasons = new Set<ContentStopDrainDegradationReason>();
  let drainFinishing = false;
  let drainPrepared = false;
  let stopDrainAckRetryTimer = 0;
  let drainDeadlineTimer = 0;

  const PORT_RECONNECT_INITIAL_MS = 250;
  const PORT_RECONNECT_MAX_MS = 5_000;
  const READY_RETRY_MS = 500;
  const ARMED_RETRY_MS = 250;
  const BIND_ACK_TIMEOUT_MS = 2_000;
  const EVENT_BATCH_ACK_TIMEOUT_MS = 2_000;
  const STOP_DRAIN_ACK_RETRY_MS = 500;
  const PENDING_EVENT_MAX = 1_200;
  const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";

  const onRuntimeMessage = (
    rawMessage: unknown,
    _sender: MessageSenderLike,
    sendResponse: (response: unknown) => void
  ) => {
    const seed = parseMainWorldControllerSeedMessage(rawMessage);
    if (seed) {
      if (!bootstrapLease.isActive()) {
        return false;
      }
      const existing = currentActivation?.mainWorldController ?? lastMainWorldController;
      if (existing) {
        sendResponse({ kind: "content.main-world-controller-seeded", controller: existing });
        return false;
      }
      lastMainWorldController = seed.controller;
      sendResponse({ kind: "content.main-world-controller-seeded", controller: seed.controller });
      queueMicrotask(() => {
        if (bootstrapLease.isActive() && currentActivation === null) {
          void requestFreshActivation("recovery");
        }
      });
      return false;
    }

    const message = parseContentControlMessage(rawMessage);

    if (message?.kind === "sw.request-content-ready") {
      sendResponse({ kind: "content.ready-requested" });

      if (bootstrapLease.isActive()) {
        void requestFreshActivation("requested", message.sameDocumentTransition);
      }

      return false;
    }

    if (!bootstrapLease.isActive()) {
      return false;
    }

    if (isContentMarkerCommand(rawMessage)) {
      void emitKeyboardMarker();
      return false;
    }

    if (message) {
      void handleControlMessage(message);
    }

    return false;
  };

  chromeApi?.runtime?.onMessage.addListener(onRuntimeMessage);

  const unbindPageLifecycle = bindContentPageLifecycle(window, {
    dispose: cleanup,
    resume: resumeFromBackForwardCache,
    suspend: suspendForBackForwardCache
  });

  void requestFreshActivation("recovery");

  function resumeFromBackForwardCache(): void {
    if (!bootstrapLease.resume()) {
      return;
    }

    lifecycleVersion += 1;
    void requestFreshActivation("pageshow");
  }

  function suspendForBackForwardCache(): void {
    if (!bootstrapLease.suspend()) {
      return;
    }

    lifecycleVersion += 1;
    deactivateCurrentActivation("bfcache-suspend", true, true);
    awaitingReady = null;
    captureAgentPromise = null;
    stopReadyRetry();
  }

  function cleanup(): void {
    if (!bootstrapLease.dispose()) {
      return;
    }

    lifecycleVersion += 1;
    deactivateCurrentActivation("document-dispose", false);
    awaitingReady = null;
    lastActivationHint = undefined;
    lastMainWorldController = null;
    stopReadyRetry();
    removeRuntimeMessageListener();
    unbindPageLifecycle();
    captureAgent?.dispose();
    captureAgent = null;
    captureAgentPromise = null;
  }

  function removeRuntimeMessageListener(): void {
    const onMessage = chromeApi?.runtime?.onMessage as
      | {
          removeListener?: (listener: typeof onRuntimeMessage) => void;
        }
      | undefined;
    onMessage?.removeListener?.(onRuntimeMessage);
  }

  async function requestFreshActivation(
    reason: AwaitingReady["reason"],
    sameDocumentTransition?: ContentSameDocumentTransition
  ): Promise<void> {
    if (!bootstrapLease.isActive() || !chromeApi?.runtime?.sendMessage) {
      return;
    }

    if (reason === "recovery" && exactReactivationPending) {
      return;
    }

    const documentUrl = readDocumentUrl();
    if (!documentUrl) {
      return;
    }

    let readyId: ContentReadyId;

    try {
      readyId = createContentReadyId();
    } catch (error) {
      debugPortSendFailure("content.ready.id", error);
      return;
    }

    const currentActivationId = currentActivation?.activationId ?? lastActivationHint;
    const mainWorldController = currentActivation?.mainWorldController ?? lastMainWorldController;
    const trustedSameDocumentTransition = authorizeSameDocumentQueueTransition(
      sameDocumentTransition,
      documentUrl
    );
    if (exactReactivationPending && reason === "requested") {
      exactReactivationPending = false;
    }
    deactivateCurrentActivation("fresh-ready", true, true);
    const epoch = (activationEpoch += 1);

    const request: AwaitingReady = {
      epoch,
      readyId,
      reason,
      ...(currentActivationId ? { currentActivationId } : {}),
      documentUrl,
      mainWorldController,
      ...(trustedSameDocumentTransition
        ? { sameDocumentTransition: trustedSameDocumentTransition }
        : {})
    };
    awaitingReady = request;
    stopReadyRetry();
    await sendReadyRequest(request);
  }

  async function sendReadyRequest(request: AwaitingReady): Promise<void> {
    if (!isCurrentReadyRequest(request) || !chromeApi?.runtime?.sendMessage) {
      return;
    }

    try {
      const response = await chromeApi.runtime.sendMessage({
        kind: "content.ready",
        readyId: request.readyId,
        reason: request.reason,
        ...(request.currentActivationId
          ? { currentActivationId: request.currentActivationId }
          : {}),
        documentUrl: request.documentUrl,
        mainWorldController: request.mainWorldController
      });

      if (!isCurrentReadyRequest(request)) {
        return;
      }

      const message = parseContentControlMessage(response);
      if (message) {
        await handleControlMessage(message);
      } else {
        scheduleReadyRetry(request);
      }
    } catch (error) {
      if (isCurrentReadyRequest(request)) {
        debugPortSendFailure("content.ready", error);
        scheduleReadyRetry(request);
      }
    }
  }

  function isCurrentReadyRequest(request: AwaitingReady): boolean {
    return (
      bootstrapLease.isActive() && awaitingReady === request && request.epoch === activationEpoch
    );
  }

  function scheduleReadyRetry(request: AwaitingReady): void {
    if (!isCurrentReadyRequest(request) || readyRetryTimer > 0) {
      return;
    }

    readyRetryTimer = window.setTimeout(() => {
      readyRetryTimer = 0;
      void sendReadyRequest(request);
    }, READY_RETRY_MS);
  }

  function stopReadyRetry(): void {
    if (readyRetryTimer > 0) {
      clearTimeout(readyRetryTimer);
      readyRetryTimer = 0;
    }
  }

  async function handleControlMessage(message: ContentControlMessage): Promise<void> {
    switch (message.kind) {
      case "sw.request-content-ready":
        await requestFreshActivation("requested", message.sameDocumentTransition);
        return;
      case "sw.content-inactive":
        if (awaitingReady?.readyId === message.readyId) {
          awaitingReady = null;
          stopReadyRetry();
        }
        return;
      case "sw.content-prepare":
        await prepareActivation(message);
        return;
      case "sw.content-activated":
        await activatePreparedContent(message.activationId);
        return;
      case "sw.content-bound":
        bindActivatedContent(message.activationId);
        return;
      case "sw.content-events-ack":
        acknowledgeContentEventBatch(message.activationId, message.batchId);
        return;
      case "sw.content-url":
        if (
          currentActivation?.activationId === message.activationId &&
          (message.revision > currentActivation.urlRevision ||
            (message.revision === currentActivation.urlRevision &&
              message.documentUrl !== currentActivation.documentUrl)) &&
          readDocumentUrl() === message.documentUrl
        ) {
          currentActivation.documentUrl = message.documentUrl;
          currentActivation.urlRevision = message.revision;
        }
        return;
      case "sw.content-quiesce":
        await quiesceActivation(message.activationId);
        return;
      case "sw.content-drain":
        await drainActivation(message);
        return;
      case "sw.content-revoked":
        if (currentActivation?.activationId === message.activationId) {
          exactReactivationPending = message.reason === "same-document-policy-pending";
          deactivateCurrentActivation(
            message.reason,
            true,
            message.reason !== "runtime-stop" &&
              message.reason !== "content-delivery-mismatch" &&
              message.reason !== "content-delivery-inconsistent"
          );
          // Same-document policy rotation is service-worker-owned: it follows this
          // revocation with an exact request that carries the queue transition.
          // A generic recovery here races that request and can discard its proof.
          if (message.reason !== "same-document-policy-pending") {
            void requestFreshActivation("recovery");
          }
        }
        return;
      case "sw.content-reset":
        exactReactivationPending = false;
        deactivateCurrentActivation(message.reason, false);
        awaitingReady = null;
        stopReadyRetry();
        void requestFreshActivation("recovery");
        return;
      case "sw.freeze":
        if (currentActivation?.sid === message.sid) {
          captureAgent?.setIndicatorState(message.sid, "freeze");
        }
        return;
    }
  }

  async function quiesceActivation(activationId: ContentActivationId): Promise<void> {
    const activation = currentActivation;
    if (
      !activation ||
      activation.activationId !== activationId ||
      (activation.phase !== "active-bound" &&
        activation.phase !== "active-unbound" &&
        activation.phase !== "quiescing-bound" &&
        activation.phase !== "quiescing-unbound")
    ) {
      return;
    }

    await ensureStopIntentQuiescence(activation);
  }

  function ensureStopIntentQuiescence(activation: ContentActivation): Promise<boolean> {
    if (stopIntentQuiescence?.activationId === activation.activationId) {
      return stopIntentQuiescence.promise;
    }

    if (activation.phase === "active-bound") {
      activation.phase = "quiescing-bound";
    } else if (activation.phase === "active-unbound") {
      activation.phase = "quiescing-unbound";
      disconnectContentPort();
    }
    stopPendingEventFlush();
    stopEventBatchAckTimer();
    cancelPortReconnectTimer();

    const promise = (async () => {
      const agent = captureAgent;
      try {
        agent?.quiesceOrdinaryCapture();
        agent?.flush();
      } catch (error) {
        debugPortSendFailure("content.quiesce.ordinary", error);
      }

      const injectedDrained =
        activation.mode === "lite" ? await drainInjectedCaptureBridge(activation) : true;

      try {
        agent?.freezeOrdinaryCapture();
        agent?.flush();
      } catch (error) {
        debugPortSendFailure("content.quiesce.finalize", error);
      }
      return injectedDrained;
    })();
    stopIntentQuiescence = { activationId: activation.activationId, promise };
    return promise;
  }

  async function prepareActivation(message: ContentPrepareMessage): Promise<void> {
    const request = awaitingReady;

    if (!request || request.readyId !== message.readyId || request.epoch !== activationEpoch) {
      return;
    }

    awaitingReady = null;
    stopReadyRetry();
    const activation: ContentActivation = {
      epoch: request.epoch,
      readyId: message.readyId,
      activationId: message.activationId,
      sid: message.sid,
      tabId: message.tabId,
      mode: message.mode,
      sampling: message.sampling,
      capturePolicy: message.capturePolicy,
      mainWorldController: message.mainWorldController,
      ...(request.sameDocumentTransition
        ? { sameDocumentTransition: request.sameDocumentTransition }
        : {}),
      documentUrl: request.documentUrl,
      urlRevision: 0,
      phase: "prepared"
    };
    currentActivation = activation;
    lastActivationHint = activation.activationId;

    try {
      await ensureCaptureAgent();
    } catch (error) {
      if (currentActivation === activation) {
        deactivateCurrentActivation("capture-agent-load-failed", true);
        debugPortSendFailure("content-agent.load", error);
        window.setTimeout(() => {
          if (bootstrapLease.isActive() && currentActivation === null) {
            void requestFreshActivation("recovery");
          }
        }, READY_RETRY_MS);
      }
      return;
    }

    if (!isCurrentActivation(activation, "prepared")) {
      return;
    }

    if (activation.mode === "lite") {
      const mainWorldActivation = await requestMainWorldControl(activation, "activate");
      if (mainWorldActivation?.result.kind !== "activated") {
        deactivateCurrentActivation("main-world-control-failed", true);
        void requestFreshActivation("recovery");
        return;
      }
    }
    void sendContentArmed(activation);
  }

  async function sendContentArmed(activation: ContentActivation): Promise<void> {
    if (
      !currentActivation ||
      currentActivation !== activation ||
      (activation.phase !== "prepared" && activation.phase !== "armed") ||
      !chromeApi?.runtime?.sendMessage
    ) {
      return;
    }

    activation.phase = "armed";

    try {
      const response = await chromeApi.runtime.sendMessage({
        kind: "content.armed",
        readyId: activation.readyId,
        activationId: activation.activationId,
        documentUrl: activation.documentUrl
      });

      if (!isCurrentActivation(activation, "armed")) {
        return;
      }

      const message = parseContentControlMessage(response);
      if (message) {
        await handleControlMessage(message);
      } else {
        scheduleArmedRetry(activation);
      }
    } catch (error) {
      if (isCurrentActivation(activation, "armed")) {
        debugPortSendFailure("content.armed", error);
        scheduleArmedRetry(activation);
      }
    }
  }

  function scheduleArmedRetry(activation: ContentActivation): void {
    if (!isCurrentActivation(activation, "armed") || armedRetryTimer > 0) {
      return;
    }

    armedRetryTimer = window.setTimeout(() => {
      armedRetryTimer = 0;
      void sendContentArmed(activation);
    }, ARMED_RETRY_MS);
  }

  function stopArmedRetry(): void {
    if (armedRetryTimer > 0) {
      clearTimeout(armedRetryTimer);
      armedRetryTimer = 0;
    }
  }

  async function activatePreparedContent(activationId: ContentActivationId): Promise<void> {
    const activation = currentActivation;

    if (
      !activation ||
      activation.activationId !== activationId ||
      (activation.phase !== "prepared" && activation.phase !== "armed")
    ) {
      return;
    }

    const agent = await ensureCaptureAgent();
    if (
      !currentActivation ||
      currentActivation !== activation ||
      (activation.phase !== "prepared" && activation.phase !== "armed")
    ) {
      return;
    }

    restoreRecoverableEventQueue(activation);
    stopArmedRetry();
    stopPendingEventFlush();
    stopDrainContext = null;
    agent.setRecordingStatus(toActiveAgentState(activation));
    activation.phase = "active-unbound";

    connectContentPort();
  }

  function restoreRecoverableEventQueue(activation: ContentActivation): void {
    const recovered = recoverableEventQueue;
    recoverableEventQueue = null;
    pendingEventBatch = null;
    pendingEvents = [];

    const restored = restoreRecoverableContentEventQueue(
      recovered,
      activation,
      readDocumentUrl(),
      PENDING_EVENT_MAX,
      activation.sameDocumentTransition
    );
    if (!restored) {
      return;
    }

    pendingEventBatch = restored.pendingBatch;
    pendingEvents = restored.pendingEvents;
  }

  function connectContentPort(): void {
    const activation = currentActivation;

    if (
      !activation ||
      (activation.phase !== "active-unbound" && activation.phase !== "draining") ||
      !chromeApi?.runtime ||
      contentPort
    ) {
      return;
    }

    try {
      const port = chromeApi.runtime.connect({ name: PORT_NAMES.content });
      bindContentPort(port, activation);
    } catch (error) {
      debugPortSendFailure("runtime.connect", error);
      schedulePortReconnect();
    }
  }

  function bindContentPort(port: PortLike, activation: ContentActivation): void {
    if (
      currentActivation !== activation ||
      (activation.phase !== "active-unbound" && activation.phase !== "draining")
    ) {
      port.disconnect?.();
      return;
    }

    cancelPortReconnectTimer();
    contentPort = port;
    contentPortBound = false;

    const onMessage = (rawMessage: unknown) => {
      if (contentPort !== port) {
        return;
      }

      const message = parseContentControlMessage(rawMessage);
      if (message) {
        void handleControlMessage(message);
      }
    };

    const onDisconnect = () => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);

      if (contentPort !== port) {
        return;
      }

      contentPort = null;
      contentPortBound = false;
      stopBindAckTimer();
      stopEventBatchAckTimer();
      stopPendingEventFlush();

      if (
        currentActivation === activation &&
        (activation.phase === "active-bound" || activation.phase === "active-unbound")
      ) {
        activation.phase = "active-unbound";
        bindFailures += 1;

        if (bindFailures >= 3) {
          void requestFreshActivation("recovery");
        } else {
          schedulePortReconnect();
        }
      } else if (currentActivation === activation && activation.phase === "draining") {
        schedulePortReconnect();
      }
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);

    try {
      port.postMessage({
        kind: "content.bind",
        activationId: activation.activationId,
        documentUrl: activation.documentUrl
      });
      bindAckTimer = window.setTimeout(() => {
        bindAckTimer = 0;

        if (
          contentPort === port &&
          currentActivation === activation &&
          (activation.phase === "active-unbound" || activation.phase === "draining")
        ) {
          bindFailures += 1;
          disconnectContentPort();

          if (bindFailures >= 3 && activation.phase !== "draining") {
            void requestFreshActivation("recovery");
          } else {
            schedulePortReconnect();
          }
        }
      }, BIND_ACK_TIMEOUT_MS);
    } catch (error) {
      debugPortSendFailure("content.bind", error);
      bindFailures += 1;
      disconnectContentPort();

      if (bindFailures >= 3 && activation.phase !== "draining") {
        void requestFreshActivation("recovery");
      } else {
        schedulePortReconnect();
      }
    }
  }

  function bindActivatedContent(activationId: ContentActivationId): void {
    const activation = currentActivation;

    if (
      !activation ||
      activation.activationId !== activationId ||
      (activation.phase !== "active-unbound" && activation.phase !== "draining") ||
      !contentPort
    ) {
      return;
    }

    const draining = activation.phase === "draining";
    if (!draining) {
      activation.phase = "active-bound";
    }
    contentPortBound = true;
    reconnectAttempts = 0;
    bindFailures = 0;
    stopBindAckTimer();
    if (pendingEventBatch) {
      sendPendingEventBatch();
    } else {
      schedulePendingEventFlush(pendingEvents.length >= CONTENT_EVENT_FLUSH_CHUNK);
    }

    if (draining) {
      void finishDrain(activation);
    }
  }

  function disconnectContentPort(): void {
    const port = contentPort;
    contentPort = null;
    contentPortBound = false;
    stopBindAckTimer();
    stopEventBatchAckTimer();

    if (!port) {
      return;
    }

    try {
      port.disconnect?.();
    } catch (error) {
      debugPortSendFailure("runtime.disconnect", error);
    }
  }

  function schedulePortReconnect(): void {
    const activation = currentActivation;

    if (
      !activation ||
      (activation.phase !== "active-unbound" && activation.phase !== "draining") ||
      !chromeApi?.runtime ||
      reconnectTimer > 0 ||
      contentPort
    ) {
      return;
    }

    const delay = Math.min(
      PORT_RECONNECT_INITIAL_MS * 2 ** reconnectAttempts,
      PORT_RECONNECT_MAX_MS
    );
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0;
      connectContentPort();
    }, delay);
  }

  function stopPortReconnect(): void {
    reconnectAttempts = 0;
    bindFailures = 0;
    cancelPortReconnectTimer();
  }

  function cancelPortReconnectTimer(): void {
    if (reconnectTimer > 0) {
      clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    }
  }

  function stopBindAckTimer(): void {
    if (bindAckTimer > 0) {
      clearTimeout(bindAckTimer);
      bindAckTimer = 0;
    }
  }

  function emitBatch(events: RawRecorderEvent[], activationId: string): void {
    const activation = currentActivation;

    if (
      !activation ||
      activation.activationId !== activationId ||
      (activation.phase !== "active-unbound" &&
        activation.phase !== "active-bound" &&
        activation.phase !== "quiescing-unbound" &&
        activation.phase !== "quiescing-bound" &&
        activation.phase !== "draining") ||
      events.length === 0 ||
      events.some(
        (event) =>
          event.source !== "content" ||
          event.sid !== activation.sid ||
          event.tabId !== activation.tabId
      )
    ) {
      return;
    }

    if (deactivateForLocalUrlDrift(activation)) {
      return;
    }

    pendingEvents.push(...events);
    trimPendingEvents();

    if (activation.phase === "active-bound" || activation.phase === "draining") {
      schedulePendingEventFlush(pendingEvents.length >= CONTENT_EVENT_FLUSH_CHUNK);
    }
  }

  function trimPendingEvents(): void {
    if (pendingEvents.length > PENDING_EVENT_MAX) {
      pendingEvents.splice(0, pendingEvents.length - PENDING_EVENT_MAX);
    }
  }

  function flushPendingEventsChunk(): boolean {
    const activation = currentActivation;

    if (
      !activation ||
      !contentPort ||
      !contentPortBound ||
      pendingEventBatch !== null ||
      (activation.phase !== "active-bound" && activation.phase !== "draining") ||
      pendingEvents.length === 0
    ) {
      return false;
    }

    if (deactivateForLocalUrlDrift(activation)) {
      return false;
    }

    let batchId: ContentEventBatchId;

    try {
      batchId = createContentEventBatchId();
    } catch (error) {
      debugPortSendFailure("content.events.id", error);
      deactivateCurrentActivation("event-batch-id-failed", true);
      return false;
    }

    pendingEventBatch = {
      batchId,
      events: pendingEvents.splice(0, CONTENT_EVENT_FLUSH_CHUNK),
      documentUrl: stopDrainContext?.documentUrl ?? activation.documentUrl,
      ...(stopDrainContext ? { stopDrainToken: stopDrainContext.token } : {})
    };

    return sendPendingEventBatch();
  }

  function sendPendingEventBatch(): boolean {
    const activation = currentActivation;
    const batch = pendingEventBatch;

    if (
      !activation ||
      !batch ||
      !contentPort ||
      !contentPortBound ||
      (activation.phase !== "active-bound" && activation.phase !== "draining")
    ) {
      return false;
    }

    try {
      contentPort.postMessage({
        kind: "content.events",
        activationId: activation.activationId,
        batchId: batch.batchId,
        events: batch.events,
        documentUrl: batch.documentUrl,
        ...(batch.stopDrainToken ? { stopDrainToken: batch.stopDrainToken } : {})
      });
      startEventBatchAckTimer(batch.batchId);
    } catch (error) {
      debugPortSendFailure("content.events", error);
      disconnectContentPort();

      if (activation.phase === "active-bound") {
        activation.phase = "active-unbound";
        schedulePortReconnect();
      }
      return false;
    }

    return true;
  }

  function flushPendingEvents(): void {
    if (!flushPendingEventsChunk()) {
      return;
    }

    if (pendingEvents.length > 0) {
      schedulePendingEventFlush(pendingEvents.length >= CONTENT_EVENT_FLUSH_CHUNK);
    }
  }

  async function flushAllPendingEvents(): Promise<void> {
    stopPendingEventFlush();

    if (pendingEventBatch) {
      sendPendingEventBatch();
      return;
    }

    flushPendingEventsChunk();
  }

  function acknowledgeContentEventBatch(
    activationId: ContentActivationId,
    batchId: ContentEventBatchId
  ): void {
    const activation = currentActivation;
    const batch = pendingEventBatch;

    if (!activation || activation.activationId !== activationId || batch?.batchId !== batchId) {
      return;
    }

    stopEventBatchAckTimer();
    pendingEventBatch = null;

    if (pendingEvents.length > 0) {
      schedulePendingEventFlush(true);
    }

    if (activation.phase === "draining") {
      void finishDrain(activation);
    }
  }

  function startEventBatchAckTimer(batchId: ContentEventBatchId): void {
    stopEventBatchAckTimer();
    eventBatchAckTimer = window.setTimeout(() => {
      eventBatchAckTimer = 0;

      if (pendingEventBatch?.batchId !== batchId) {
        return;
      }

      const activation = currentActivation;
      if (activation?.phase === "active-bound") {
        activation.phase = "active-unbound";
      }
      disconnectContentPort();
      schedulePortReconnect();
    }, EVENT_BATCH_ACK_TIMEOUT_MS);
  }

  function stopEventBatchAckTimer(): void {
    if (eventBatchAckTimer > 0) {
      clearTimeout(eventBatchAckTimer);
      eventBatchAckTimer = 0;
    }
  }

  function schedulePendingEventFlush(immediate = false): void {
    const activation = currentActivation;

    if (
      !activation ||
      !contentPort ||
      !contentPortBound ||
      (activation.phase !== "active-bound" && activation.phase !== "draining") ||
      pendingEvents.length === 0
    ) {
      return;
    }

    const delayMs = resolveContentEventFlushDelay(pendingEvents.length, immediate);

    if (pendingEventFlushTimer > 0) {
      if (delayMs >= pendingEventFlushDelayMs) {
        return;
      }

      clearTimeout(pendingEventFlushTimer);
      pendingEventFlushTimer = 0;
    }

    pendingEventFlushDelayMs = delayMs;
    pendingEventFlushTimer = window.setTimeout(() => {
      pendingEventFlushTimer = 0;
      pendingEventFlushDelayMs = Number.POSITIVE_INFINITY;
      flushPendingEvents();
    }, delayMs);
  }

  function stopPendingEventFlush(): void {
    if (pendingEventFlushTimer > 0) {
      clearTimeout(pendingEventFlushTimer);
      pendingEventFlushTimer = 0;
    }

    pendingEventFlushDelayMs = Number.POSITIVE_INFINITY;
  }

  function emitMarker(message: string): void {
    const activation = currentActivation;

    if (!activation || activation.phase !== "active-bound" || !contentPort) {
      return;
    }

    if (deactivateForLocalUrlDrift(activation)) {
      return;
    }

    try {
      contentPort.postMessage({
        kind: "content.marker",
        activationId: activation.activationId,
        message,
        documentUrl: activation.documentUrl
      });
    } catch (error) {
      debugPortSendFailure("content.marker", error);
    }
  }

  async function emitKeyboardMarker(): Promise<void> {
    const activation = currentActivation;

    if (
      !activation ||
      (activation.phase !== "active-unbound" && activation.phase !== "active-bound")
    ) {
      return;
    }

    const agent = await ensureCaptureAgent();
    if (currentActivation === activation) {
      agent.emitMarker(keyboardMarkerMessage);
    }
  }

  async function drainActivation(
    message: Extract<ContentControlMessage, { kind: "sw.content-drain" }>
  ): Promise<void> {
    const activation = currentActivation;

    if (
      !activation ||
      activation.activationId !== message.activationId ||
      activation.sid !== message.sid ||
      (activation.phase !== "active-bound" &&
        activation.phase !== "active-unbound" &&
        activation.phase !== "quiescing-bound" &&
        activation.phase !== "quiescing-unbound")
    ) {
      return;
    }

    const context = resolveContentStopDrainContext(message);
    if (!context) {
      return;
    }

    if (
      context.documentUrl !== activation.documentUrl &&
      readDocumentUrl() === context.documentUrl
    ) {
      activation.documentUrl = context.documentUrl;
      activation.urlRevision += 1;
    }

    if (context.documentUrl !== activation.documentUrl || deactivateForLocalUrlDrift(activation)) {
      return;
    }

    const stopIntentQuiescence = ensureStopIntentQuiescence(activation);
    activation.phase = "draining";
    stopDrainContext = context;
    drainFinishing = false;
    drainPrepared = false;
    stopDrainExpectedArtifacts.clear();
    stopDrainEmittedArtifacts.clear();
    stopDrainOmittedArtifacts.clear();
    stopDrainDegradationReasons.clear();
    for (const artifact of resolveExpectedContentStopArtifacts(activation)) {
      stopDrainExpectedArtifacts.add(artifact);
    }
    stopDrainAckRetry();
    cancelPortReconnectTimer();
    reconnectAttempts = 0;
    startDrainDeadlineTimer(activation, context.deadline);

    if (pendingEventBatch) {
      pendingEventBatch.documentUrl = context.documentUrl;
      pendingEventBatch.stopDrainToken = context.token;
      stopEventBatchAckTimer();
    }

    if (!contentPort) {
      connectContentPort();
    } else if (contentPortBound && pendingEventBatch) {
      sendPendingEventBatch();
    }

    if (activation.mode === "lite") {
      const injectedDrained = await stopIntentQuiescence;
      if (injectedDrained) {
        stopDrainEmittedArtifacts.add("main-world-tail");
      } else {
        stopDrainDegradationReasons.add("main-world-tail-timeout");
      }
    }

    const agent = captureAgent;

    if (agent) {
      if (!(await runBestEffortContentDrainStep("freeze", () => agent.freezeOrdinaryCapture()))) {
        stopDrainDegradationReasons.add("content-drain-error");
      }
      if (
        !(await runBestEffortContentDrainStep("ordinary-flush", async () => {
          agent.flush();
          await flushAllPendingEvents();
        }))
      ) {
        stopDrainDegradationReasons.add("content-drain-error");
      }

      if (activation.mode === "lite" && window.top === window) {
        try {
          const result = await agent.prepareStopCapture();
          for (const artifact of result.emittedArtifacts) {
            stopDrainEmittedArtifacts.add(artifact);
          }
          if (result.degradationReason) {
            stopDrainDegradationReasons.add(result.degradationReason);
          }
        } catch (error) {
          stopDrainDegradationReasons.add("artifact-error");
          debugPortSendFailure("content.drain.final-artifacts", error);
        }
      }

      if (
        !(await runBestEffortContentDrainStep("inactive", () =>
          agent.setRecordingStatus(toInactiveAgentState(activation))
        ))
      ) {
        stopDrainDegradationReasons.add("content-drain-error");
      }
    } else if (stopDrainExpectedArtifacts.size > 0) {
      stopDrainDegradationReasons.add("inactive");
    }

    for (const artifact of stopDrainExpectedArtifacts) {
      if (!stopDrainEmittedArtifacts.has(artifact)) {
        stopDrainOmittedArtifacts.add(artifact);
      }
    }

    drainPrepared = true;

    if (!isCurrentActivation(activation, "draining") || Date.now() > context.deadline) {
      return;
    }

    if (!contentPort || !contentPortBound) {
      schedulePortReconnect();
      return;
    }

    await finishDrain(activation);
  }

  async function runBestEffortContentDrainStep(
    stage: string,
    step: () => void | Promise<void>
  ): Promise<boolean> {
    try {
      await step();
      return true;
    } catch (error) {
      debugPortSendFailure(`content.drain.${stage}`, error);
      return false;
    }
  }

  function resolveExpectedContentStopArtifacts(
    activation: ContentActivation
  ): ContentStopDrainArtifact[] {
    if (activation.mode !== "lite") {
      return [];
    }

    const expected: ContentStopDrainArtifact[] = ["main-world-tail"];
    if (window.top !== window) {
      return expected;
    }
    if (activation.capturePolicy.categories.dom !== "off") {
      expected.push("snapshot");
    }
    if (activation.capturePolicy.categories.storage !== "off") {
      expected.push("localStorageSnapshot");
    }
    if (
      (activation.sampling?.screenshotIdleMs ?? 0) > 0 &&
      activation.capturePolicy.categories.screenshots === "allow"
    ) {
      expected.push("screenshot");
    }
    return expected;
  }

  async function finishDrain(activation: ContentActivation): Promise<void> {
    const context = stopDrainContext;

    if (
      drainFinishing ||
      !drainPrepared ||
      !context ||
      !isCurrentActivation(activation, "draining") ||
      !contentPortBound ||
      Date.now() > context.deadline
    ) {
      return;
    }

    drainFinishing = true;

    try {
      await flushAllPendingEvents();

      if (pendingEventBatch || pendingEvents.length > 0) {
        return;
      }

      if (
        !isCurrentActivation(activation, "draining") ||
        !contentPort ||
        !contentPortBound ||
        Date.now() > context.deadline
      ) {
        if (!contentPort && Date.now() <= context.deadline) {
          schedulePortReconnect();
        }
        return;
      }

      const acknowledgement = buildContentStopDrainedMessage(context, {
        expectedArtifacts: [...stopDrainExpectedArtifacts],
        emittedArtifacts: [...stopDrainEmittedArtifacts],
        omittedArtifacts: [...stopDrainOmittedArtifacts],
        degradationReasons: [...stopDrainDegradationReasons]
      });
      if (acknowledgement) {
        contentPort.postMessage(acknowledgement);
        scheduleStopDrainAckRetry(activation);
      }
    } catch (error) {
      debugPortSendFailure("content.stop-drained", error);
      disconnectContentPort();
      schedulePortReconnect();
    } finally {
      drainFinishing = false;
    }
  }

  function deactivateCurrentActivation(
    reason: string,
    preserveHint: boolean,
    preserveEventQueue = false
  ): void {
    const activation = currentActivation;

    if (activation && preserveHint) {
      lastActivationHint = activation.activationId;
      lastMainWorldController = activation.mainWorldController;
    }

    if (activation && preserveEventQueue) {
      try {
        captureAgent?.flush();
      } catch (error) {
        debugPortSendFailure("content.recovery.flush", error);
      }
      retainRecoverableEventQueue(activation);
    } else if (!preserveEventQueue) {
      recoverableEventQueue = null;
    }

    currentActivation = null;
    stopDrainContext = null;
    stopIntentQuiescence = null;
    stopDrainExpectedArtifacts.clear();
    stopDrainEmittedArtifacts.clear();
    stopDrainOmittedArtifacts.clear();
    stopDrainDegradationReasons.clear();
    drainFinishing = false;
    drainPrepared = false;
    stopDrainAckRetry();
    stopDrainDeadlineTimer();
    stopEventBatchAckTimer();
    stopArmedRetry();
    stopBindAckTimer();
    stopPortReconnect();
    stopPendingEventFlush();
    pendingEvents = [];
    pendingEventBatch = null;

    if (activation) {
      if (activation.mode === "lite" && activation.mainWorldController?.phase === "active") {
        void requestMainWorldControl(activation, "deactivate", preserveHint);
      }
      captureAgent?.setRecordingStatus(toInactiveAgentState(activation));
    }

    disconnectContentPort();

    if (!preserveHint) {
      lastActivationHint = undefined;
      lastMainWorldController = null;
    }

    debugActivationTransition(reason);
  }

  function retainRecoverableEventQueue(activation: ContentActivation): void {
    const captured = captureRecoverableContentEventQueue({
      identity: activation,
      phase: activation.phase,
      pendingBatch: pendingEventBatch,
      pendingEvents
    });
    if (captured) {
      recoverableEventQueue = captured;
    }
  }

  function authorizeSameDocumentQueueTransition(
    transition: ContentSameDocumentTransition | undefined,
    documentUrl: string
  ): ContentSameDocumentTransition | undefined {
    if (
      !transition ||
      transition.documentUrl !== documentUrl ||
      transition.previousDocumentUrl === transition.documentUrl
    ) {
      return undefined;
    }

    const activation = currentActivation;
    const currentMatches = Boolean(
      activation &&
      (activation.phase === "active-bound" || activation.phase === "active-unbound") &&
      activation.activationId === transition.previousActivationId &&
      activation.documentUrl === transition.previousDocumentUrl
    );
    const recoveredQueueMatches = Boolean(
      recoverableEventQueue?.activationId === transition.previousActivationId &&
      recoverableEventQueue.documentUrl === transition.previousDocumentUrl
    );
    const recoveredWithoutActivation = Boolean(
      !activation && lastActivationHint === transition.previousActivationId && recoveredQueueMatches
    );
    const provisionalPredecessor = activation?.sameDocumentTransition;
    const recoveredBehindProvisional = Boolean(
      activation &&
      (activation.phase === "prepared" || activation.phase === "armed") &&
      recoveredQueueMatches &&
      recoverableEventQueue?.sid === activation.sid &&
      recoverableEventQueue.tabId === activation.tabId &&
      recoverableEventQueue.mode === activation.mode &&
      provisionalPredecessor?.previousActivationId === transition.previousActivationId &&
      provisionalPredecessor.previousDocumentUrl === transition.previousDocumentUrl &&
      provisionalPredecessor.documentUrl === activation.documentUrl &&
      provisionalPredecessor.frameId === transition.frameId &&
      provisionalPredecessor.documentId === transition.documentId &&
      provisionalPredecessor.revision < transition.revision
    );
    const recoveredMatches = recoveredWithoutActivation || recoveredBehindProvisional;

    if (!currentMatches && !recoveredMatches) {
      return undefined;
    }

    return transition;
  }

  function startDrainDeadlineTimer(activation: ContentActivation, deadline: number): void {
    stopDrainDeadlineTimer();
    const remaining = Math.max(0, deadline - Date.now());
    drainDeadlineTimer = window.setTimeout(() => {
      drainDeadlineTimer = 0;
      if (isCurrentActivation(activation, "draining")) {
        deactivateCurrentActivation("drain-deadline", true);
      }
    }, remaining);
  }

  function scheduleStopDrainAckRetry(activation: ContentActivation): void {
    stopDrainAckRetry();
    stopDrainAckRetryTimer = window.setTimeout(() => {
      stopDrainAckRetryTimer = 0;
      if (isCurrentActivation(activation, "draining")) {
        void finishDrain(activation);
      }
    }, STOP_DRAIN_ACK_RETRY_MS);
  }

  function stopDrainAckRetry(): void {
    if (stopDrainAckRetryTimer > 0) {
      clearTimeout(stopDrainAckRetryTimer);
      stopDrainAckRetryTimer = 0;
    }
  }

  function stopDrainDeadlineTimer(): void {
    if (drainDeadlineTimer > 0) {
      clearTimeout(drainDeadlineTimer);
      drainDeadlineTimer = 0;
    }
  }

  function deactivateForLocalUrlDrift(activation: ContentActivation): boolean {
    if (readDocumentUrl() === activation.documentUrl) {
      return false;
    }

    if (currentActivation === activation) {
      deactivateCurrentActivation("document-url-drift", true);
      void requestFreshActivation("recovery");
    }
    return true;
  }

  function isCurrentActivation(
    activation: ContentActivation,
    phase: ContentActivationPhase
  ): boolean {
    return (
      bootstrapLease.isActive() &&
      currentActivation === activation &&
      activation.epoch === activationEpoch &&
      activation.phase === phase
    );
  }

  async function ensureCaptureAgent(): Promise<LiteCaptureAgent> {
    if (captureAgent) {
      return captureAgent;
    }

    if (captureAgentPromise) {
      return captureAgentPromise;
    }

    const moduleUrl = chromeApi?.runtime?.getURL?.("content-agent.js") ?? "./content-agent.js";
    const requestLifecycleVersion = lifecycleVersion;
    const promise = import(moduleUrl).then((module) => {
      const { createContentCaptureAgent } = module as ContentAgentModule;
      const options: LiteCaptureAgentOptions = {
        emitBatch,
        onMarker: emitMarker,
        showIndicator: true
      };
      const agent = createContentCaptureAgent(options);

      if (!bootstrapLease.isActive() || requestLifecycleVersion !== lifecycleVersion) {
        agent.dispose();
        return agent;
      }

      captureAgent = agent;
      return agent;
    });
    captureAgentPromise = promise;
    void promise.then(
      () => {
        if (captureAgentPromise === promise) {
          captureAgentPromise = null;
        }
      },
      () => {
        if (captureAgentPromise === promise) {
          captureAgentPromise = null;
        }
      }
    );
    return promise;
  }

  function toActiveAgentState(activation: ContentActivation): LiteCaptureState {
    return {
      active: true,
      activationId: activation.activationId,
      sid: activation.sid,
      tabId: activation.tabId,
      mode: activation.mode,
      sampling: activation.sampling,
      capturePolicy: activation.capturePolicy
    };
  }

  function toInactiveAgentState(activation: ContentActivation): LiteCaptureState {
    return {
      active: false,
      activationId: activation.activationId,
      sid: activation.sid,
      tabId: activation.tabId,
      mode: activation.mode,
      sampling: activation.sampling,
      capturePolicy: activation.capturePolicy
    };
  }

  async function requestMainWorldControl(
    activation: ContentActivation,
    operation: "activate" | "deactivate" | "drain",
    rememberController = true
  ): Promise<ReturnType<typeof parseContentMainWorldControlResult>> {
    const controller = activation.mainWorldController;
    if (!controller || !chromeApi?.runtime?.sendMessage) {
      return null;
    }

    try {
      const rawResponse = await chromeApi.runtime.sendMessage({
        kind: "content.main-world-control",
        activationId: activation.activationId,
        documentUrl: activation.documentUrl,
        operation
      });
      const response = parseContentMainWorldControlResult(rawResponse);
      if (
        !response ||
        response.activationId !== activation.activationId ||
        response.operation !== operation ||
        !sameMainWorldControllerCapability(controller, response.controller)
      ) {
        return null;
      }
      activation.mainWorldController = response.controller;
      if (
        rememberController &&
        (!lastMainWorldController ||
          sameMainWorldControllerCapability(lastMainWorldController, response.controller))
      ) {
        lastMainWorldController = response.controller;
      }
      return response;
    } catch (error) {
      debugPortSendFailure(`injected.direct.${operation}`, error);
      return null;
    }
  }

  async function drainInjectedCaptureBridge(activation: ContentActivation): Promise<boolean> {
    if (activation.mode !== "lite") {
      return true;
    }

    const response = await requestMainWorldControl(activation, "drain");
    if (!response || response.result.kind !== "drained") {
      return false;
    }
    return captureAgent?.mergeInjectedDirectReplay(response.result).confirmed === true;
  }

  function readDocumentUrl(): string | null {
    try {
      const url = window.location.href;
      return typeof url === "string" && url.length > 0 ? url : null;
    } catch {
      return null;
    }
  }

  function debugPortSendFailure(kind: string, error: unknown): void {
    const flags = globalThis as unknown as Record<string, unknown>;
    const enabled = flags[PORT_DEBUG_LOG_FLAG] === true || flags.__WEBBLACKBOX_PERF__ === true;

    if (enabled) {
      console.debug("[WebBlackbox][port] content operation failed", {
        kind,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function debugActivationTransition(reason: string): void {
    const flags = globalThis as unknown as Record<string, unknown>;
    if (flags[PORT_DEBUG_LOG_FLAG] === true) {
      console.debug("[WebBlackbox][activation] content deactivated", { reason });
    }
  }
}
