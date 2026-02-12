type ChromeActionApi = {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
};

type ChromeRuntimeApi = {
  onInstalled: {
    addListener(callback: () => void): void;
  };
};

type ChromeLike = {
  action?: ChromeActionApi;
  runtime?: ChromeRuntimeApi;
};

console.info("[WebBlackbox] service worker booted");

const chromeApi = (globalThis as { chrome?: ChromeLike }).chrome;

chromeApi?.runtime?.onInstalled.addListener(() => {
  void chromeApi.action?.setBadgeText({ text: "WB" });
  void chromeApi.action?.setBadgeBackgroundColor({ color: "#1864ab" });
});
