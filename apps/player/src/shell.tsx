import * as React from "react";

import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { Input } from "./components/ui/input.js";
import { Select } from "./components/ui/select.js";

export function PlayerShell(): React.JSX.Element {
  return (
    <section className="shell">
      <header className="topbar card">
        <div className="topbar-copy">
          <p className="eyebrow">WebBlackbox</p>
          <h1>Session Player</h1>
          <p className="subhead">
            Screenshot playback on top, timeline controls in the middle, and logs synced to playhead
            below.
          </p>
        </div>
        <div className="topbar-actions">
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

      <Card className="stage-card">
        <div className="stage-head">
          <div>
            <p className="eyebrow">Playback</p>
            <h2 className="stage-title">Visual Timeline</h2>
          </div>
          <div className="stage-tools">
            <label className="mask-wrap" htmlFor="mask-response-preview">
              <Checkbox id="mask-response-preview" defaultChecked />
              Mask preview
            </label>
            <div className="time-chip">
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
          <img id="filmstrip-preview" alt="Screenshot playback" className="preview" />
          <svg id="filmstrip-trail-svg" className="preview-trail" aria-hidden="true"></svg>
          <div id="filmstrip-cursor" className="preview-cursor" hidden></div>
          <div id="stage-placeholder" className="stage-placeholder">
            Load an archive to start playback.
          </div>
        </div>

        <div className="transport-row">
          <div className="playback-buttons">
            <Button id="playback-back" type="button" variant="outline">
              -1s
            </Button>
            <Button id="playback-toggle" type="button">
              Play
            </Button>
            <Button id="playback-forward" type="button" variant="outline">
              +1s
            </Button>
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
          </div>

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

      <Card className="ops-card">
        <section id="summary" className="summary"></section>

        <section className="actions">
          <Button id="export-report" type="button">
            Export Bug Report
          </Button>
          <Button id="export-har" type="button">
            Export HAR
          </Button>
          <Button id="export-playwright" type="button">
            Export Playwright
          </Button>
          <Button id="export-playwright-mocks" type="button">
            Export Playwright Mocks
          </Button>
          <Button id="export-github-issue" type="button">
            Export GitHub Issue
          </Button>
          <Button id="export-jira-issue" type="button">
            Export Jira Issue
          </Button>
          <span id="feedback" className="feedback"></span>
        </section>

        <section className="filters">
          <Input id="text-filter" type="search" placeholder="Search timeline payloads" />
          <Select id="type-filter">
            <option value="all">All Timeline Events</option>
            <option value="errors">Errors</option>
            <option value="network">Network</option>
            <option value="storage">Storage</option>
            <option value="console">Console</option>
          </Select>
        </section>
      </Card>

      <section className="panel-tabs" id="panel-tabs">
        <Button
          className="panel-tab active"
          data-log-panel="timeline"
          type="button"
          variant="ghost"
        >
          Timeline
        </Button>
        <Button className="panel-tab" data-log-panel="details" type="button" variant="ghost">
          Event
        </Button>
        <Button className="panel-tab" data-log-panel="network" type="button" variant="ghost">
          Network
        </Button>
        <Button className="panel-tab" data-log-panel="compare" type="button" variant="ghost">
          Compare
        </Button>
        <Button className="panel-tab" data-log-panel="console" type="button" variant="ghost">
          Console
        </Button>
        <Button className="panel-tab" data-log-panel="realtime" type="button" variant="ghost">
          Realtime
        </Button>
        <Button className="panel-tab" data-log-panel="storage" type="button" variant="ghost">
          Storage
        </Button>
        <Button className="panel-tab" data-log-panel="perf" type="button" variant="ghost">
          Performance
        </Button>
      </section>

      <section className="log-grid">
        <Card className="timeline-card" data-log-panel-target="timeline">
          <h2>Timeline (&lt;= Playhead)</h2>
          <ul id="timeline-list" className="event-list"></ul>
        </Card>

        <Card className="details-card" data-log-panel-target="details">
          <h2>Event Details</h2>
          <pre id="event-details" className="code"></pre>
        </Card>

        <Card className="network-card" data-log-panel-target="network">
          <h2>Network Waterfall (&lt;= Playhead)</h2>
          <div className="waterfall-wrap">
            <table className="waterfall-table">
              <thead>
                <tr>
                  <th align="left">Request</th>
                  <th align="left">Status</th>
                  <th align="left">Duration</th>
                  <th align="left">Action</th>
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
          </div>
          <pre id="request-details" className="code"></pre>
        </Card>

        <Card className="compare-card" data-log-panel-target="compare">
          <h2>Compare Summary</h2>
          <pre id="compare-details" className="code"></pre>
        </Card>

        <Card data-log-panel-target="console">
          <h2>Console &amp; Errors (&lt;= Playhead)</h2>
          <ul id="console-list" className="signal-list"></ul>
        </Card>

        <Card data-log-panel-target="realtime">
          <h2>Realtime WS/SSE (&lt;= Playhead)</h2>
          <ul id="realtime-list" className="signal-list"></ul>
        </Card>

        <Card data-log-panel-target="storage">
          <h2>Storage Timeline (&lt;= Playhead)</h2>
          <ul id="storage-list" className="signal-list"></ul>
        </Card>

        <Card data-log-panel-target="perf">
          <h2>Performance Artifacts (&lt;= Playhead)</h2>
          <ul id="perf-list" className="signal-list"></ul>
        </Card>
      </section>
    </section>
  );
}
