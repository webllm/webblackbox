export function createDeploymentMarker(commit, tag = null) {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Invalid deployment commit: ${commit}`);
  }

  return {
    schemaVersion: 1,
    commit,
    tag: typeof tag === "string" && tag.length > 0 ? tag : null
  };
}

export async function waitForSiteDeployment({
  siteUrl,
  expectedCommit,
  timeoutMs = 180_000,
  pollIntervalMs = 5_000,
  fetchImplementation = fetch
}) {
  const startedAt = Date.now();
  let lastStatus = "unknown";

  while (Date.now() - startedAt < timeoutMs) {
    const cacheBuster = `${expectedCommit}-${Date.now()}`;
    const pageUrl = new URL(siteUrl);
    pageUrl.searchParams.set("deployment", cacheBuster);
    const markerUrl = new URL("deployment.json", ensureTrailingSlash(siteUrl));
    markerUrl.searchParams.set("deployment", cacheBuster);

    try {
      const [pageResponse, markerResponse] = await Promise.all([
        fetchImplementation(pageUrl, requestOptions),
        fetchImplementation(markerUrl, requestOptions)
      ]);
      const [pageBody, markerBody] = await Promise.all([
        pageResponse.text(),
        markerResponse.json()
      ]);
      const markerCommit =
        markerBody && typeof markerBody === "object" && typeof markerBody.commit === "string"
          ? markerBody.commit
          : "missing";

      lastStatus = `page=${pageResponse.status} marker=${markerResponse.status} commit=${markerCommit}`;
      if (
        pageResponse.ok &&
        markerResponse.ok &&
        pageBody.includes("<title>WebBlackbox Player</title>") &&
        markerCommit === expectedCommit
      ) {
        return;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for ${siteUrl} to serve commit ${expectedCommit}. Last status: ${lastStatus}`
  );
}

const requestOptions = {
  cache: "no-store",
  redirect: "follow",
  headers: {
    "cache-control": "no-cache"
  }
};

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
