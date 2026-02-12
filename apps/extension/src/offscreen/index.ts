import { getChromeApi } from "../shared/chrome-api.js";
import { PORT_NAMES } from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.offscreen });

type OffscreenState = {
  active: boolean;
  activeSessions: number;
  updatedAt: number | null;
};

const state: OffscreenState = {
  active: false,
  activeSessions: 0,
  updatedAt: null
};

console.info("[WebBlackbox] offscreen pipeline initialized");

port?.onMessage.addListener((message) => {
  if (message && typeof message === "object") {
    const kind = (message as { kind?: unknown }).kind;

    if (kind === "sw.recording-status") {
      const active = (message as { active?: unknown }).active;
      state.active = active === true;
      console.info("[WebBlackbox] offscreen status", message);
    }

    if (kind === "sw.pipeline-status") {
      const activeSessions = (message as { activeSessions?: unknown }).activeSessions;
      const updatedAt = (message as { updatedAt?: unknown }).updatedAt;

      state.activeSessions =
        typeof activeSessions === "number" && Number.isFinite(activeSessions) ? activeSessions : 0;
      state.updatedAt = typeof updatedAt === "number" ? updatedAt : Date.now();

      console.info("[WebBlackbox] offscreen pipeline status", {
        active: state.active,
        activeSessions: state.activeSessions,
        updatedAt: state.updatedAt
      });
    }
  }
});

port?.postMessage({
  kind: "offscreen.ready",
  t: Date.now()
});
