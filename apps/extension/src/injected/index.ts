import { installInjectedLiteCaptureHooks } from "webblackbox/injected-hooks";

installInjectedLiteCaptureHooks({
  active: false,
  bodyCaptureMaxBytes: 0,
  captureNetwork: false
});
