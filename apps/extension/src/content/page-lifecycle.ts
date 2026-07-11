type ContentPageLifecycleTarget = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};

export type ContentPageLifecycleHooks = {
  dispose(): void;
  resume(): void;
  suspend(): void;
};

/**
 * Binds only definitive page lifecycle transitions. `beforeunload` is
 * deliberately excluded because the navigation can still be canceled.
 */
export function bindContentPageLifecycle(
  target: ContentPageLifecycleTarget,
  hooks: ContentPageLifecycleHooks
): () => void {
  const onPageHide: EventListener = (event) => {
    if ((event as PageTransitionEvent).persisted === true) {
      hooks.suspend();
      return;
    }

    hooks.dispose();
  };

  const onPageShow: EventListener = (event) => {
    if ((event as PageTransitionEvent).persisted === true) {
      hooks.resume();
    }
  };

  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);

  return () => {
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("pageshow", onPageShow);
  };
}
