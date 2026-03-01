import * as React from "react";

import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { Input } from "./components/ui/input.js";
import { Select } from "./components/ui/select.js";

export function PlayerShell(): React.JSX.Element {
  return (
    <main id="player-shell" className="shell wb-shell">
      <header className="toolbar card" role="banner">
        <div className="toolbar-left">
          <span className="brand">WebBlackbox</span>
          <span className="toolbar-separator" aria-hidden="true"></span>
          <span className="toolbar-title">Player</span>
        </div>
        <div className="toolbar-loaders">
          <label className="upload" htmlFor="archive-input">
            Load Archive
          </label>
          <Input id="archive-input" type="file" accept=".webblackbox,.zip" />
          <label className="upload secondary" htmlFor="compare-input">
            Load Compare
          </label>
          <Input id="compare-input" type="file" accept=".webblackbox,.zip" />
        </div>
      </header>

      <section className="status-bar card" aria-live="polite">
        <div className="status-metrics">
          <span className="status-item">
            <span className="status-label">Window</span>
            <span id="playback-window-label" className="mono status-value">
              0.00s / 0.00s
            </span>
          </span>
          <span id="playback-window-events" className="status-item muted">
            0 events | 0 errors | 0 requests
          </span>
          <span id="playback-window-panel" className="status-item muted">
            Event panel
          </span>
        </div>
        <div className="status-actions">
          <label className="mask-wrap" htmlFor="mask-response-preview">
            <Checkbox id="mask-response-preview" defaultChecked />
            Mask response preview
          </label>
          <span id="feedback" className="feedback"></span>
        </div>
      </section>

      <section id="preflight-panel" className="preflight-panel card" hidden>
        <header className="preflight-head">
          <div>
            <h2 id="preflight-title">Quick Triage</h2>
            <p id="preflight-meta" className="preflight-meta"></p>
          </div>
          <Button id="preflight-dismiss" type="button" variant="ghost">
            Dismiss
          </Button>
        </header>
        <div className="preflight-metrics">
          <div className="preflight-pill">
            <span>Errors</span>
            <strong id="preflight-errors">0</strong>
          </div>
          <div className="preflight-pill">
            <span>Failed reqs</span>
            <strong id="preflight-failed-requests">0</strong>
          </div>
          <div className="preflight-pill">
            <span>Slow reqs</span>
            <strong id="preflight-slow-requests">0</strong>
          </div>
          <div className="preflight-pill">
            <span>Screenshots</span>
            <strong id="preflight-shots">0</strong>
          </div>
          <div className="preflight-pill">
            <span>Actions</span>
            <strong id="preflight-actions">0</strong>
          </div>
        </div>
        <div className="preflight-actions">
          <Button id="preflight-open-player" type="button" variant="secondary">
            Open Full Player
          </Button>
          <Button id="preflight-copy-report" type="button" variant="secondary">
            Copy Bug Report
          </Button>
          <Button id="preflight-jump-error" type="button" variant="secondary">
            Jump to first error
          </Button>
          <Button id="preflight-jump-slowest" type="button" variant="secondary">
            Jump to slowest request
          </Button>
        </div>
      </section>

      <Card id="stage-card" className="stage-card">
        <div className="stage-toolbar">
          <div className="playback-buttons">
            <Button
              id="playback-back"
              className="transport-btn transport-btn-step"
              type="button"
              variant="secondary"
            >
              -1s
            </Button>
            <Button
              id="playback-toggle"
              className="transport-btn transport-btn-play"
              type="button"
              variant="secondary"
            >
              Play
            </Button>
            <Button
              id="playback-forward"
              className="transport-btn transport-btn-step"
              type="button"
              variant="secondary"
            >
              +1s
            </Button>
          </div>
          <div className="stage-toolbar-right">
            <label className="rate-wrap" htmlFor="playback-rate">
              Speed
              <Select id="playback-rate" defaultValue="1">
                <option value="0.5">0.5x</option>
                <option value="1">1x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
                <option value="4">4x</option>
              </Select>
            </label>
            <div className="time-chip" aria-label="Playback time">
              <span id="playback-current" className="mono">
                0.00s
              </span>
              <span className="time-divider">/</span>
              <span id="playback-total" className="mono">
                0.00s
              </span>
            </div>
          </div>
        </div>

        <div className="stage-frame" id="filmstrip-preview-wrap">
          <img id="filmstrip-preview" alt="Screenshot playback" className="preview" hidden />
          <svg id="filmstrip-trail-svg" className="preview-trail" aria-hidden="true"></svg>
          <div id="filmstrip-cursor" className="preview-cursor" hidden></div>
          <div id="stage-placeholder" className="stage-placeholder">
            Load an archive to start playback.
          </div>
        </div>

        <div className="transport-row">
          <div className="playback-track-wrap">
            <div id="progress-shell" className="progress-shell">
              <Input
                id="playback-progress"
                type="range"
                min="0"
                max="1"
                step="1"
                defaultValue="0"
              />
              <div id="playback-markers" className="progress-markers" aria-hidden="true"></div>
              <div id="playback-playhead" className="progress-playhead" aria-hidden="true"></div>
              <div id="progress-hover" className="progress-hover" hidden>
                <img
                  id="progress-hover-image"
                  className="progress-hover-image"
                  alt="Progress preview"
                  hidden
                />
                <div id="progress-hover-time" className="mono progress-hover-time">
                  0.00s
                </div>
                <div id="progress-hover-tags" className="progress-hover-tags"></div>
                <div id="progress-hover-text" className="progress-hover-text"></div>
                <section id="progress-hover-response" className="progress-hover-response" hidden>
                  <header className="progress-hover-response-head">
                    <span
                      id="progress-hover-response-badge"
                      className="progress-hover-response-badge"
                      aria-hidden="true"
                    ></span>
                    <span
                      id="progress-hover-response-meta"
                      className="progress-hover-response-meta"
                    ></span>
                  </header>
                  <div className="progress-hover-response-actions">
                    <Button
                      id="progress-hover-response-toggle"
                      type="button"
                      size="sm"
                      variant="secondary"
                    >
                      Expand JSON
                    </Button>
                    <Button
                      id="progress-hover-response-copy"
                      type="button"
                      size="sm"
                      variant="secondary"
                    >
                      Copy
                    </Button>
                  </div>
                  <pre
                    id="progress-hover-response-body"
                    className="progress-hover-response-body"
                  ></pre>
                </section>
              </div>
            </div>

            <div className="progress-legend" aria-hidden="true">
              <span className="legend-item">
                <i className="legend-dot legend-error"></i>Error
              </span>
              <span className="legend-item">
                <i className="legend-dot legend-network"></i>Network
              </span>
              <span className="legend-item">
                <i className="legend-dot legend-screenshot"></i>Screenshot
              </span>
              <span className="legend-item">
                <i className="legend-dot legend-action"></i>Action
              </span>
            </div>
          </div>
        </div>

        <div className="filmstrip-wrap">
          <p id="filmstrip-meta" className="mono"></p>
          <ul id="filmstrip-list" className="shot-strip"></ul>
        </div>
      </Card>

      <div
        id="stage-divider"
        className="stage-divider"
        role="separator"
        aria-label="Resize screenshot stage"
        aria-orientation="horizontal"
        tabIndex={0}
      ></div>

      <section className="ops card">
        <section id="summary" className="summary"></section>
        <div className="ops-grid">
          <section className="filters">
            <Input id="text-filter" type="search" placeholder="Filter timeline" />
            <Select id="type-filter">
              <option value="all">All Timeline Events</option>
              <option value="errors">Errors</option>
              <option value="network">Network</option>
              <option value="storage">Storage</option>
              <option value="console">Console</option>
            </Select>
          </section>
          <section className="actions">
            <Button id="export-report" type="button" variant="secondary">
              Bug Report
            </Button>
            <Button id="export-har" type="button" variant="secondary">
              HAR
            </Button>
            <Button id="export-playwright" type="button" variant="secondary">
              Playwright
            </Button>
            <Button id="export-playwright-mocks" type="button" variant="secondary">
              PW Mocks
            </Button>
            <Button id="export-github-issue" type="button" variant="secondary">
              GitHub
            </Button>
            <Button id="export-jira-issue" type="button" variant="secondary">
              Jira
            </Button>
            <Button id="share-upload" type="button" variant="secondary">
              Share
            </Button>
            <Button id="load-share-url" type="button" variant="secondary">
              Load Shared
            </Button>
          </section>
        </div>
      </section>

      <section className="panel-tabs-wrap card">
        <section className="panel-tabs" id="panel-tabs" role="tablist" aria-label="Log panels">
          <Button
            className="panel-tab active"
            data-log-panel="details"
            data-count="0"
            type="button"
            variant="ghost"
          >
            Event
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="actions"
            data-count="0"
            type="button"
            variant="ghost"
          >
            Actions
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="network"
            data-count="0"
            type="button"
            variant="ghost"
          >
            Network
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="compare"
            data-count="0"
            type="button"
            variant="ghost"
          >
            Compare
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="console"
            data-count="0"
            type="button"
            variant="ghost"
          >
            Console
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="realtime"
            data-count="0"
            type="button"
            variant="ghost"
          >
            Realtime
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="storage"
            data-count="0"
            type="button"
            variant="ghost"
          >
            Storage
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="perf"
            data-count="0"
            type="button"
            variant="ghost"
          >
            Performance
          </Button>
        </section>
      </section>

      <section className="panel-stage">
        <section className="log-grid" id="log-grid">
          <Card className="timeline-card" data-log-panel-target="timeline">
            <h2>Timeline</h2>
            <ul id="timeline-list" className="event-list"></ul>
          </Card>

          <div
            id="log-grid-divider"
            className="log-grid-divider"
            role="separator"
            aria-label="Resize panels"
            aria-orientation="vertical"
            tabIndex={0}
          ></div>

          <Card className="details-card" data-log-panel-target="details">
            <h2>Event Details</h2>
            <pre id="event-details" className="code"></pre>
          </Card>

          <Card data-log-panel-target="actions">
            <h2>Action Timeline</h2>
            <ul id="actions-list" className="action-card-list"></ul>
          </Card>

          <Card className="network-card" data-log-panel-target="network">
            <h2>Network</h2>
            <div className="network-toolbar" role="group" aria-label="Network filters">
              <Input id="network-filter" type="search" placeholder="Filter URL, host, id, method" />
              <Select id="network-method-filter" defaultValue="all">
                <option value="all">All Methods</option>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
                <option value="OPTIONS">OPTIONS</option>
                <option value="HEAD">HEAD</option>
              </Select>
              <Select id="network-status-filter" defaultValue="all">
                <option value="all">All Status</option>
                <option value="success">2xx</option>
                <option value="redirect">3xx</option>
                <option value="client-error">4xx</option>
                <option value="server-error">5xx</option>
                <option value="failed">Failed</option>
              </Select>
              <Select id="network-type-filter" defaultValue="all">
                <option value="all">All Types</option>
                <option value="document">Document</option>
                <option value="fetch">Fetch/XHR</option>
                <option value="script">Script</option>
                <option value="stylesheet">Stylesheet</option>
                <option value="image">Image</option>
                <option value="font">Font</option>
                <option value="text">Text</option>
                <option value="other">Other</option>
              </Select>
              <span id="network-summary" className="network-summary mono">
                0 / 0 requests
              </span>
            </div>
            <div className="waterfall-wrap">
              <table className="waterfall-table">
                <thead>
                  <tr>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="name" type="button">
                        Name
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="method" type="button">
                        Method
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="status" type="button">
                        Status
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="type" type="button">
                        Type
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="initiator" type="button">
                        Initiator
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="size" type="button">
                        Size
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="time" type="button">
                        Time
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="start" type="button">
                        Waterfall
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody id="waterfall-body"></tbody>
              </table>
            </div>
            <div className="inline-actions">
              <Button id="copy-curl" type="button" variant="secondary">
                Copy cURL
              </Button>
              <Button id="copy-fetch" type="button" variant="secondary">
                Copy fetch
              </Button>
              <Button id="replay-request" type="button" variant="secondary">
                Replay request
              </Button>
            </div>
            <pre id="request-details" className="code"></pre>
          </Card>

          <Card className="compare-card" data-log-panel-target="compare">
            <h2>Compare</h2>
            <div id="compare-regressions" className="compare-regressions"></div>
            <pre id="compare-details" className="code"></pre>
          </Card>

          <Card data-log-panel-target="console">
            <h2 className="console-heading">
              <span>Console</span>
              <Input
                id="console-filter"
                type="search"
                placeholder="Filter logs by type or content"
              />
            </h2>
            <ul id="console-list" className="signal-list"></ul>
          </Card>

          <Card data-log-panel-target="realtime">
            <h2>Realtime</h2>
            <ul id="realtime-list" className="signal-list"></ul>
          </Card>

          <Card data-log-panel-target="storage">
            <h2>Storage</h2>
            <ul id="storage-list" className="signal-list"></ul>
          </Card>

          <Card data-log-panel-target="perf">
            <h2>Performance</h2>
            <ul id="perf-list" className="signal-list"></ul>
          </Card>
        </section>
      </section>

      <dialog id="share-upload-dialog" className="share-dialog">
        <form id="share-upload-form" className="share-dialog-card" method="dialog">
          <header className="share-dialog-head">
            <h2>Share Archive</h2>
            <p>Upload the loaded archive to a share server and copy the generated link.</p>
          </header>
          <label className="share-dialog-field">
            <span>Share server URL</span>
            <Input
              id="share-upload-base-url"
              className="share-dialog-input"
              type="url"
              placeholder="https://share.example.com"
              autoComplete="url"
            />
          </label>
          <label className="share-dialog-field">
            <span>Optional passphrase</span>
            <Input
              id="share-upload-passphrase"
              className="share-dialog-input"
              type="password"
              placeholder="Leave empty for public metadata only"
              autoComplete="off"
            />
          </label>
          <label className="share-dialog-field">
            <span>Optional API key</span>
            <Input
              id="share-upload-api-key"
              className="share-dialog-input"
              type="password"
              placeholder="Required when server auth is enabled"
              autoComplete="off"
            />
          </label>
          <label className="share-dialog-toggle">
            <Checkbox id="share-upload-show-passphrase" />
            Show passphrase
          </label>
          <div className="share-dialog-actions">
            <Button id="share-upload-cancel" type="button" variant="ghost" data-dialog-cancel>
              Cancel
            </Button>
            <Button id="share-upload-confirm" type="submit" value="confirm" variant="secondary">
              Share
            </Button>
          </div>
        </form>
      </dialog>

      <dialog id="share-load-dialog" className="share-dialog">
        <form id="share-load-form" className="share-dialog-card" method="dialog">
          <header className="share-dialog-head">
            <h2>Load Shared Archive</h2>
            <p>Paste a share URL, archive API URL, or share ID.</p>
          </header>
          <label className="share-dialog-field">
            <span>Share reference</span>
            <Input
              id="share-load-reference"
              className="share-dialog-input"
              type="text"
              placeholder="https://host/share/abc123 or abc123"
              autoComplete="off"
            />
          </label>
          <label className="share-dialog-field">
            <span>Optional API key</span>
            <Input
              id="share-load-api-key"
              className="share-dialog-input"
              type="password"
              placeholder="Required when server auth is enabled"
              autoComplete="off"
            />
          </label>
          <div className="share-dialog-actions">
            <Button id="share-load-cancel" type="button" variant="ghost" data-dialog-cancel>
              Cancel
            </Button>
            <Button id="share-load-confirm" type="submit" value="confirm" variant="secondary">
              Load
            </Button>
          </div>
        </form>
      </dialog>

      <dialog id="archive-passphrase-dialog" className="share-dialog">
        <form id="archive-passphrase-form" className="share-dialog-card" method="dialog">
          <header className="share-dialog-head">
            <h2>Encrypted Archive</h2>
            <p id="archive-passphrase-context">
              This archive is encrypted. Enter the passphrase to continue loading.
            </p>
          </header>
          <label className="share-dialog-field">
            <span>Passphrase</span>
            <Input
              id="archive-passphrase-input"
              className="share-dialog-input"
              type="password"
              placeholder="Required for encrypted archives"
              autoComplete="off"
            />
          </label>
          <div className="share-dialog-actions">
            <Button id="archive-passphrase-cancel" type="button" variant="ghost" data-dialog-cancel>
              Cancel
            </Button>
            <Button
              id="archive-passphrase-confirm"
              type="submit"
              value="confirm"
              variant="secondary"
            >
              Load
            </Button>
          </div>
        </form>
      </dialog>

      <div id="archive-drop-overlay" className="archive-drop-overlay" hidden>
        <div className="archive-drop-overlay-card">
          <strong>Drop Archive to Load</strong>
          <span className="mono">Supports .webblackbox and .zip</span>
        </div>
      </div>
    </main>
  );
}
