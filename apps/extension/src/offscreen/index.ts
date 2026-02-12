import { getChromeApi } from "../shared/chrome-api.js";
import { PORT_NAMES } from "../shared/messages.js";

const chromeApi = getChromeApi();
const port = chromeApi?.runtime?.connect({ name: PORT_NAMES.offscreen });

console.info("[WebBlackbox] offscreen pipeline initialized");

port?.onMessage.addListener((message) => {
  if (message && typeof message === "object") {
    const kind = (message as { kind?: unknown }).kind;

    if (kind === "sw.recording-status") {
      console.info("[WebBlackbox] offscreen status", message);
    }
  }
});
