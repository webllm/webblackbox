import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { nowUtcInput, nowUtcIsoString } from "@webblackbox/mcp-core";
import {
  compareSessions,
  compareSessionsInput,
  exportHarFromArchive,
  exportHarInput,
  findRootCauseCandidates,
  generateBugReportBundle,
  generateBugReportInput,
  generatePlaywrightFromArchive,
  generatePlaywrightInput,
  listArchives,
  listArchivesInput,
  networkIssuesInput,
  queryEvents,
  queryEventsInput,
  rootCauseCandidatesInput,
  sessionSummaryInput,
  summarizeActions,
  summarizeActionsInput,
  summarizeNetworkIssues,
  summarizeSession
} from "./session-tools.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "webblackbox-mcp-server",
    version: "0.1.0"
  });

  server.tool("health", "Health check", {}, async () => {
    return {
      content: [
        {
          type: "text",
          text: "ok"
        }
      ]
    };
  });

  server.tool("now_utc", "Get current UTC time as an ISO string", nowUtcInput, async () => {
    return {
      content: [
        {
          type: "text",
          text: nowUtcIsoString()
        }
      ]
    };
  });

  server.tool(
    "list_archives",
    "List local .webblackbox/.zip archives from a directory.",
    listArchivesInput,
    async ({ dir, recursive, limit }) => {
      return toTextPayload(await listArchives({ dir, recursive, limit }));
    }
  );

  server.tool(
    "session_summary",
    "Open an archive and return session-level summary metrics and top issues.",
    sessionSummaryInput,
    async ({ path, passphrase, slowRequestMs, topN }) => {
      return toTextPayload(
        await summarizeSession({
          path,
          passphrase,
          slowRequestMs,
          topN
        })
      );
    }
  );

  server.tool(
    "query_events",
    "Query events in an archive by text/type/level/request/range with pagination.",
    queryEventsInput,
    async ({
      path,
      passphrase,
      text,
      types,
      levels,
      requestId,
      monoStart,
      monoEnd,
      offset,
      limit,
      includeData,
      maxDataChars
    }) => {
      return toTextPayload(
        await queryEvents({
          path,
          passphrase,
          text,
          types,
          levels,
          requestId,
          monoStart,
          monoEnd,
          offset,
          limit,
          includeData,
          maxDataChars
        })
      );
    }
  );

  server.tool(
    "network_issues",
    "Summarize failed and slow network requests from an archive.",
    networkIssuesInput,
    async ({ path, passphrase, minDurationMs, limit }) => {
      return toTextPayload(
        await summarizeNetworkIssues({
          path,
          passphrase,
          minDurationMs,
          limit
        })
      );
    }
  );

  server.tool(
    "generate_bug_report",
    "Generate markdown/GitHub/Jira issue artifacts from one archive.",
    generateBugReportInput,
    async ({
      path,
      passphrase,
      title,
      maxItems,
      monoStart,
      monoEnd,
      labels,
      assignees,
      issueType,
      projectKey,
      priority
    }) => {
      return toTextPayload(
        await generateBugReportBundle({
          path,
          passphrase,
          title,
          maxItems,
          monoStart,
          monoEnd,
          labels,
          assignees,
          issueType,
          projectKey,
          priority
        })
      );
    }
  );

  server.tool(
    "export_har",
    "Export HAR JSON string from an archive, optionally within a mono range.",
    exportHarInput,
    async ({ path, passphrase, monoStart, monoEnd }) => {
      return toTextPayload(
        await exportHarFromArchive({
          path,
          passphrase,
          monoStart,
          monoEnd
        })
      );
    }
  );

  server.tool(
    "generate_playwright",
    "Generate a Playwright script from archive actions with optional range/start-url overrides.",
    generatePlaywrightInput,
    async ({
      path,
      passphrase,
      name,
      startUrl,
      maxActions,
      includeHarReplay,
      monoStart,
      monoEnd
    }) => {
      return toTextPayload(
        await generatePlaywrightFromArchive({
          path,
          passphrase,
          name,
          startUrl,
          maxActions,
          includeHarReplay,
          monoStart,
          monoEnd
        })
      );
    }
  );

  server.tool(
    "summarize_actions",
    "Summarize action spans with trigger/duration plus request, error, and screenshot context.",
    summarizeActionsInput,
    async ({ path, passphrase, monoStart, monoEnd, limit }) => {
      return toTextPayload(
        await summarizeActions({
          path,
          passphrase,
          monoStart,
          monoEnd,
          limit
        })
      );
    }
  );

  server.tool(
    "find_root_cause_candidates",
    "Find likely root-cause signals around errors (nearby failed requests, warn/error console, AI root cause hints).",
    rootCauseCandidatesInput,
    async ({ path, passphrase, monoStart, monoEnd, limit, windowMs }) => {
      return toTextPayload(
        await findRootCauseCandidates({
          path,
          passphrase,
          monoStart,
          monoEnd,
          limit,
          windowMs
        })
      );
    }
  );

  server.tool(
    "compare_sessions",
    "Compare two archives and summarize event/network/storage deltas.",
    compareSessionsInput,
    async ({
      leftPath,
      rightPath,
      leftPassphrase,
      rightPassphrase,
      topTypeDeltas,
      topRequestDiffs,
      includeStorageHashes
    }) => {
      return toTextPayload(
        await compareSessions({
          leftPath,
          rightPath,
          leftPassphrase,
          rightPassphrase,
          topTypeDeltas,
          topRequestDiffs,
          includeStorageHashes
        })
      );
    }
  );

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  });
}

function toTextPayload(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
