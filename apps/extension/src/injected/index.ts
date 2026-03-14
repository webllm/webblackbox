import { installInjectedLiteCaptureHooks } from "webblackbox/injected-hooks";

installInjectedLiteCaptureHooks({
  bodyCaptureMaxBytes: 0,
  captureNetwork: false
});
