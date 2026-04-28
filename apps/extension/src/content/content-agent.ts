import { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import type { LiteCaptureAgentOptions } from "webblackbox/types";

export function createContentCaptureAgent(options: LiteCaptureAgentOptions): LiteCaptureAgent {
  return new LiteCaptureAgent(options);
}
