export function verifyRealWorldArchiveEvidence(player, evidence) {
  const events = readPlayerEvents(player);
  const eventTexts = events.map((event) => `${event.type} ${safeStringify(event.data)}`);
  const missingMarkers = (evidence?.markers ?? []).filter(
    (marker) => !eventTexts.some((text) => text.includes(marker))
  );
  const missingUrls = (evidence?.urls ?? []).filter(
    (url) => !eventTexts.some((text) => text.includes(url))
  );
  const missingEventTypes = (evidence?.eventTypes ?? []).filter(
    (type) => !events.some((event) => event.type === type)
  );

  return {
    ok: missingMarkers.length === 0 && missingUrls.length === 0 && missingEventTypes.length === 0,
    eventCount: events.length,
    missingMarkers,
    missingUrls,
    missingEventTypes
  };
}

export async function verifyScreenRecordingArchiveEvidence(
  player,
  { captureScreenshots, maxBlobBytes }
) {
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes <= 0) {
    throw new TypeError("Screen recording evidence requires a positive blob read limit.");
  }

  const events = readPlayerEvents(player);
  const paths = readIntegrityPaths(player);
  const startEvents = events.filter((event) => event.type === "screen.recording.start");
  const chunkEvents = events.filter((event) => event.type === "screen.recording.chunk");
  const endEvents = events.filter((event) => event.type === "screen.recording.end");
  const screenshotEvents = events.filter((event) => event.type === "screen.screenshot");
  const endWithChunks = endEvents.find(
    (event) => Array.isArray(event.data?.chunks) && event.data.chunks.length > 0
  );
  const referencedChunks = new Set([
    ...chunkEvents
      .map((event) => event.data?.chunkId)
      .filter((value) => typeof value === "string" && value.length > 0),
    ...(Array.isArray(endWithChunks?.data?.chunks)
      ? endWithChunks.data.chunks.filter((value) => typeof value === "string" && value.length > 0)
      : [])
  ]);
  const webmBlobs = paths.filter((path) => path.startsWith("blobs/") && path.endsWith(".webm"));
  const screenshotBlobs = paths.filter(
    (path) => path.startsWith("blobs/") && path.endsWith(".webp")
  );
  const missingChunkBlobs = [];
  const invalidChunkBlobs = [];

  for (const hash of referencedChunks) {
    let blob;

    try {
      blob = await player.readBlobTransient(hash, maxBlobBytes);
    } catch (error) {
      invalidChunkBlobs.push({
        hash,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    if (!blob) {
      missingChunkBlobs.push(hash);
    } else if (blob.mime !== "video/webm" || (blob.bytes?.byteLength ?? 0) <= 0) {
      invalidChunkBlobs.push({
        hash,
        mime: blob.mime ?? null,
        bytes: blob.bytes?.byteLength ?? 0
      });
    }
  }

  const screenshotLeak =
    !captureScreenshots && (screenshotEvents.length > 0 || screenshotBlobs.length > 0);

  return {
    ok:
      startEvents.length > 0 &&
      chunkEvents.length > 0 &&
      endEvents.length > 0 &&
      Boolean(endWithChunks) &&
      webmBlobs.length > 0 &&
      referencedChunks.size > 0 &&
      missingChunkBlobs.length === 0 &&
      invalidChunkBlobs.length === 0 &&
      !screenshotLeak,
    startEvents: startEvents.length,
    chunkEvents: chunkEvents.length,
    endEvents: endEvents.length,
    screenshotEvents: screenshotEvents.length,
    endChunkCount: Array.isArray(endWithChunks?.data?.chunks)
      ? endWithChunks.data.chunks.length
      : 0,
    webmBlobs: webmBlobs.length,
    screenshotBlobs: screenshotBlobs.length,
    referencedChunks: referencedChunks.size,
    missingChunkBlobs,
    invalidChunkBlobs,
    screenshotLeak
  };
}

function readPlayerEvents(player) {
  const events = player?.events;

  if (!Array.isArray(events)) {
    throw new TypeError("Archive evidence requires a loaded Player instance.");
  }

  return events;
}

function readIntegrityPaths(player) {
  const files = player?.archive?.integrity?.files;
  return files && typeof files === "object" && !Array.isArray(files) ? Object.keys(files) : [];
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
