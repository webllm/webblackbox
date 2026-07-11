/** Removes in memory only when the absence checkpoint can be made durable, rolling back on failure. */
export async function commitDurableRemoval(options: {
  remove: () => boolean;
  persist: () => Promise<void>;
  restore: () => void;
}): Promise<boolean> {
  if (!options.remove()) {
    return false;
  }

  try {
    await options.persist();
    return true;
  } catch (error) {
    options.restore();
    throw error;
  }
}
