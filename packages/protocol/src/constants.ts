export const WEBBLACKBOX_PROTOCOL_VERSION = 1;

export const EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;

export const CAPTURE_MODES = ["lite", "full"] as const;

export const CHUNK_CODECS = ["none", "br", "zst", "gzip"] as const;

export const WEBBLACKBOX_EVENT_TYPES = [
  "meta.session.start",
  "meta.session.end",
  "meta.config",
  "sys.debugger.attach",
  "sys.debugger.detach",
  "sys.notice",
  "nav.commit",
  "nav.history.push",
  "nav.history.replace",
  "nav.hash",
  "nav.reload",
  "user.click",
  "user.dblclick",
  "user.keydown",
  "user.input",
  "user.submit",
  "user.scroll",
  "user.mousemove",
  "user.focus",
  "user.blur",
  "user.marker",
  "user.visibility",
  "user.resize",
  "console.entry",
  "error.exception",
  "error.unhandledrejection",
  "error.resource",
  "error.assert",
  "network.request",
  "network.response",
  "network.finished",
  "network.failed",
  "network.redirect",
  "network.body",
  "network.ws.open",
  "network.ws.frame",
  "network.ws.close",
  "network.sse.message",
  "dom.mutation.batch",
  "dom.snapshot",
  "dom.diff",
  "dom.rrweb.event",
  "screen.screenshot",
  "screen.viewport",
  "storage.cookie.snapshot",
  "storage.local.snapshot",
  "storage.local.op",
  "storage.session.op",
  "storage.idb.op",
  "storage.idb.snapshot",
  "storage.cache.op",
  "storage.sw.lifecycle",
  "perf.vitals",
  "perf.longtask",
  "perf.trace",
  "perf.cpu.profile",
  "perf.heap.snapshot"
] as const;

export const MESSAGE_TYPES = [
  "CTRL.START_SESSION",
  "CTRL.STOP_SESSION",
  "CTRL.FREEZE",
  "CTRL.EXPORT",
  "EVT.BATCH",
  "PIPE.BLOB_PUT",
  "PIPE.CHUNK_PUT",
  "PIPE.BUILD_INDEX",
  "PIPE.EXPORT_DONE"
] as const;

export const FREEZE_REASONS = ["error", "marker", "perf", "manual"] as const;

export const STORAGE_SNAPSHOT_MODES = ["schema-only", "sample", "full"] as const;
