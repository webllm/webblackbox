import * as React from "react";

import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { Input } from "./components/ui/input.js";
import { Select } from "./components/ui/select.js";
import { createPlayerI18n, type PlayerLocale } from "./lib/i18n.js";

const playerVersion = typeof __PLAYER_VERSION__ !== "undefined" ? __PLAYER_VERSION__ : "0.1.0";

type PlayerShellProps = {
  locale?: PlayerLocale;
};

export type { PlayerShellProps };

export function PlayerShell({ locale = "en" }: PlayerShellProps = {}): React.JSX.Element {
  const i18n = createPlayerI18n(locale);
  const { messages } = i18n;
  const initialStatusCounts = i18n.formatStatusCounts(0, 0, 0);
  const initialStatusPanel = i18n.formatStatusPanel("details");
  const initialScopeSummary = i18n.formatScopeSummary(0, 0);
  const initialNetworkSummary = messages.networkSummaryEmpty;

  return (
    <main id="player-shell" className="shell wb-shell">
      <header className="toolbar card" role="banner">
        <div className="toolbar-left">
          <span className="brand-lockup">
            <img className="brand-mark" src="./logo.png" alt="" width="22" height="22" />
            <span className="brand">WebBlackbox</span>
          </span>
          <span className="toolbar-separator" aria-hidden="true"></span>
          <span className="toolbar-title">{messages.toolbarTitlePlayer}</span>
          <span className="toolbar-version" aria-label={messages.toolbarPlayerVersion}>
            v{playerVersion}
          </span>
        </div>
        <div className="toolbar-loaders">
          <label className="upload" htmlFor="archive-input">
            {messages.toolbarLoadArchive}
          </label>
          <Input id="archive-input" type="file" accept=".webblackbox,.zip" />
          <label className="upload secondary" htmlFor="compare-input">
            {messages.toolbarLoadCompare}
          </label>
          <Input id="compare-input" type="file" accept=".webblackbox,.zip" />
          <label className="toolbar-locale" htmlFor="player-locale">
            <span className="toolbar-locale__label">{messages.toolbarLanguage}</span>
            <Select
              id="player-locale"
              defaultValue={i18n.locale}
              aria-label={messages.toolbarLanguage}
            >
              <option value="en">{messages.localeNames.en}</option>
              <option value="zh-CN">{messages.localeNames["zh-CN"]}</option>
            </Select>
          </label>
          <a
            className="upload secondary upload-link"
            href="https://github.com/webllm/webblackbox"
            target="_blank"
            rel="noreferrer"
          >
            {messages.toolbarGitHubRepo}
          </a>
        </div>
      </header>

      <section className="status-bar card" aria-live="polite">
        <div className="status-metrics">
          <span className="status-item">
            <span className="status-label">{messages.statusWindow}</span>
            <span id="playback-window-label" className="mono status-value">
              0.00s / 0.00s
            </span>
          </span>
          <span id="playback-window-events" className="status-item muted">
            {initialStatusCounts}
          </span>
          <span id="playback-window-panel" className="status-item muted">
            {initialStatusPanel}
          </span>
        </div>
        <div className="status-actions">
          <label className="triage-wrap" htmlFor="quick-triage-dismiss-seconds">
            <span>{messages.quickTriage}</span>
            <Input
              id="quick-triage-dismiss-seconds"
              type="number"
              min="1"
              max="120"
              step="1"
              defaultValue="10"
            />
            <span>s</span>
          </label>
          <label className="mask-wrap" htmlFor="mask-response-preview">
            <Checkbox id="mask-response-preview" defaultChecked />
            {messages.maskResponsePreview}
          </label>
          <span id="feedback" className="feedback"></span>
        </div>
      </section>

      <section id="preflight-panel" className="preflight-panel card" hidden>
        <header className="preflight-head">
          <div>
            <h2 id="preflight-title">{messages.quickTriage}</h2>
            <p id="preflight-meta" className="preflight-meta"></p>
          </div>
          <Button id="preflight-dismiss" type="button" variant="ghost">
            {messages.dismiss}
          </Button>
        </header>
        <div className="preflight-metrics">
          <div className="preflight-pill">
            <span>{messages.preflightErrors}</span>
            <strong id="preflight-errors">0</strong>
          </div>
          <div className="preflight-pill">
            <span>{messages.preflightFailedReqs}</span>
            <strong id="preflight-failed-requests">0</strong>
          </div>
          <div className="preflight-pill">
            <span>{messages.preflightSlowReqs}</span>
            <strong id="preflight-slow-requests">0</strong>
          </div>
          <div className="preflight-pill">
            <span>{messages.preflightScreenshots}</span>
            <strong id="preflight-shots">0</strong>
          </div>
          <div className="preflight-pill">
            <span>{messages.preflightActions}</span>
            <strong id="preflight-actions">0</strong>
          </div>
        </div>
        <div className="preflight-actions">
          <Button id="preflight-open-player" type="button" variant="secondary">
            {messages.preflightOpenFullPlayer}
          </Button>
          <Button id="preflight-copy-report" type="button" variant="secondary">
            {messages.preflightCopyBugReport}
          </Button>
          <Button id="preflight-jump-error" type="button" variant="secondary">
            {messages.preflightJumpFirstError}
          </Button>
          <Button id="preflight-jump-slowest" type="button" variant="secondary">
            {messages.preflightJumpSlowestRequest}
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
              {messages.playbackBackStep}
            </Button>
            <Button
              id="playback-toggle"
              className="transport-btn transport-btn-play"
              type="button"
              variant="secondary"
            >
              {messages.playbackPlay}
            </Button>
            <Button
              id="playback-forward"
              className="transport-btn transport-btn-step"
              type="button"
              variant="secondary"
            >
              {messages.playbackForwardStep}
            </Button>
          </div>
          <div className="stage-toolbar-right">
            <label className="rate-wrap" htmlFor="playback-rate">
              {messages.playbackSpeed}
              <Select id="playback-rate" defaultValue="1">
                <option value="0.5">0.5x</option>
                <option value="1">1x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
                <option value="4">4x</option>
              </Select>
            </label>
            <div className="time-chip" aria-label={messages.playbackTime}>
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
          <img
            id="filmstrip-preview"
            alt={messages.previewAltScreenshotPlayback}
            className="preview"
            hidden
          />
          <svg id="filmstrip-trail-svg" className="preview-trail" aria-hidden="true"></svg>
          <div id="filmstrip-cursor" className="preview-cursor" hidden></div>
          <label id="stage-placeholder" className="stage-placeholder" htmlFor="archive-input">
            <div className="stage-placeholder__content">
              <img
                className="stage-placeholder__logo"
                src="./logo.png"
                alt=""
                width="88"
                height="88"
              />
              <p className="stage-placeholder__text">{messages.stagePlaceholderLoadArchive}</p>
            </div>
          </label>
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
                  alt={messages.previewAltProgressPreview}
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
                      {messages.responseExpandJson}
                    </Button>
                    <Button
                      id="progress-hover-response-copy"
                      type="button"
                      size="sm"
                      variant="secondary"
                    >
                      {messages.copy}
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
                <i className="legend-dot legend-error"></i>
                {messages.progressLegendError}
              </span>
              <span className="legend-item">
                <i className="legend-dot legend-network"></i>
                {messages.progressLegendNetwork}
              </span>
              <span className="legend-item">
                <i className="legend-dot legend-screenshot"></i>
                {messages.progressLegendScreenshot}
              </span>
              <span className="legend-item">
                <i className="legend-dot legend-action"></i>
                {messages.progressLegendAction}
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
        aria-label={messages.resizeScreenshotStage}
        aria-orientation="horizontal"
        tabIndex={0}
      ></div>

      <section className="ops card">
        <section id="summary" className="summary"></section>
        <div className="ops-grid">
          <section className="filters">
            <Input
              id="text-filter"
              type="search"
              placeholder={messages.filterTimelinePlaceholder}
            />
            <Select id="type-filter">
              <option value="all">{messages.filterAllTimelineEvents}</option>
              <option value="errors">{messages.filterErrors}</option>
              <option value="network">{messages.filterNetwork}</option>
              <option value="storage">{messages.filterStorage}</option>
              <option value="console">{messages.filterConsole}</option>
            </Select>
            <Select id="scope-filter" defaultValue="all">
              <option value="all">{messages.scopeFilterAll}</option>
              <option value="main">{messages.scopeFilterMain}</option>
              <option value="iframe">{messages.scopeFilterIframe}</option>
            </Select>
          </section>
          <section className="actions">
            <Button id="export-report" type="button" variant="secondary">
              {messages.exportBugReport}
            </Button>
            <Button id="export-har" type="button" variant="secondary">
              {messages.exportHar}
            </Button>
            <Button id="export-playwright" type="button" variant="secondary">
              {messages.exportPlaywright}
            </Button>
            <Button id="export-playwright-mocks" type="button" variant="secondary">
              {messages.exportPlaywrightMocks}
            </Button>
            <Button id="export-github-issue" type="button" variant="secondary">
              {messages.exportGitHub}
            </Button>
            <Button id="export-jira-issue" type="button" variant="secondary">
              {messages.exportJira}
            </Button>
            <Button id="share-upload" type="button" variant="secondary">
              {messages.share}
            </Button>
            <Button id="load-share-url" type="button" variant="secondary">
              {messages.loadShared}
            </Button>
          </section>
        </div>
      </section>

      <section className="panel-tabs-wrap card">
        <section
          className="panel-tabs"
          id="panel-tabs"
          role="tablist"
          aria-label={messages.panelTabsLabel}
        >
          <Button
            className="panel-tab active"
            data-log-panel="details"
            data-count="0"
            type="button"
            variant="ghost"
          >
            {messages.panels.details}
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="actions"
            data-count="0"
            type="button"
            variant="ghost"
          >
            {messages.panels.actions}
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="network"
            data-count="0"
            type="button"
            variant="ghost"
          >
            {messages.panels.network}
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="compare"
            data-count="0"
            type="button"
            variant="ghost"
          >
            {messages.panels.compare}
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="console"
            data-count="0"
            type="button"
            variant="ghost"
          >
            {messages.panels.console}
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="realtime"
            data-count="0"
            type="button"
            variant="ghost"
          >
            {messages.panels.realtime}
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="storage"
            data-count="0"
            type="button"
            variant="ghost"
          >
            {messages.panels.storage}
          </Button>
          <Button
            className="panel-tab"
            data-log-panel="perf"
            data-count="0"
            type="button"
            variant="ghost"
          >
            {messages.panels.perf}
          </Button>
        </section>
      </section>

      <section className="panel-stage">
        <section className="log-grid" id="log-grid">
          <Card className="timeline-card" data-log-panel-target="timeline">
            <h2>{messages.panels.timeline}</h2>
            <ul id="timeline-list" className="event-list"></ul>
          </Card>

          <div
            id="log-grid-divider"
            className="log-grid-divider"
            role="separator"
            aria-label={messages.resizePanels}
            aria-orientation="vertical"
            tabIndex={0}
          ></div>

          <Card className="details-card" data-log-panel-target="details">
            <h2>{messages.eventDetailsHeading}</h2>
            <pre id="event-details" className="code"></pre>
          </Card>

          <Card data-log-panel-target="actions">
            <h2>{messages.actionTimelineHeading}</h2>
            <ul id="actions-list" className="action-card-list"></ul>
          </Card>

          <Card className="network-card" data-log-panel-target="network">
            <h2>{messages.networkHeading}</h2>
            <div className="network-toolbar" role="group" aria-label={messages.networkFiltersLabel}>
              <Input
                id="network-filter"
                type="search"
                placeholder={messages.networkFilterPlaceholder}
              />
              <Select id="network-method-filter" defaultValue="all">
                <option value="all">{messages.networkAllMethods}</option>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
                <option value="OPTIONS">OPTIONS</option>
                <option value="HEAD">HEAD</option>
              </Select>
              <Select id="network-status-filter" defaultValue="all">
                <option value="all">{messages.networkAllStatus}</option>
                <option value="success">2xx</option>
                <option value="redirect">3xx</option>
                <option value="client-error">4xx</option>
                <option value="server-error">5xx</option>
                <option value="failed">{messages.networkStatusFailed}</option>
              </Select>
              <Select id="network-type-filter" defaultValue="all">
                <option value="all">{messages.networkAllTypes}</option>
                <option value="document">{messages.networkTypes.document}</option>
                <option value="fetch">{messages.networkTypes.fetch}</option>
                <option value="script">{messages.networkTypes.script}</option>
                <option value="stylesheet">{messages.networkTypes.stylesheet}</option>
                <option value="image">{messages.networkTypes.image}</option>
                <option value="font">{messages.networkTypes.font}</option>
                <option value="text">{messages.networkTypes.text}</option>
                <option value="other">{messages.networkTypes.other}</option>
              </Select>
              <Select id="network-scope-filter" defaultValue="all">
                <option value="all">{messages.scopeFilterAll}</option>
                <option value="main">{messages.scopeFilterMain}</option>
                <option value="iframe">{messages.scopeFilterIframe}</option>
              </Select>
              <span id="network-scope-summary" className="network-scope-summary mono">
                {initialScopeSummary}
              </span>
              <span id="network-summary" className="network-summary mono">
                {initialNetworkSummary}
              </span>
            </div>
            <div className="waterfall-wrap">
              <table className="waterfall-table">
                <thead>
                  <tr>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="name" type="button">
                        {messages.networkColumnName}
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="method" type="button">
                        {messages.networkColumnMethod}
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="status" type="button">
                        {messages.networkColumnStatus}
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="type" type="button">
                        {messages.networkColumnType}
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="initiator" type="button">
                        {messages.networkColumnInitiator}
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="size" type="button">
                        {messages.networkColumnSize}
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="time" type="button">
                        {messages.networkColumnTime}
                      </button>
                    </th>
                    <th align="left">
                      <button className="wf-sort-btn" data-wf-sort-key="start" type="button">
                        {messages.networkColumnWaterfall}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody id="waterfall-body"></tbody>
              </table>
            </div>
            <div className="inline-actions">
              <Button id="copy-curl" type="button" variant="secondary">
                {messages.copyCurl}
              </Button>
              <Button id="copy-fetch" type="button" variant="secondary">
                {messages.copyFetch}
              </Button>
              <Button id="replay-request" type="button" variant="secondary">
                {messages.replayRequest}
              </Button>
            </div>
            <pre id="request-details" className="code"></pre>
          </Card>

          <Card className="compare-card" data-log-panel-target="compare">
            <h2>{messages.compareHeading}</h2>
            <div id="compare-regressions" className="compare-regressions"></div>
            <pre id="compare-details" className="code"></pre>
          </Card>

          <Card data-log-panel-target="console">
            <h2 className="console-heading">
              <span>{messages.consoleHeading}</span>
              <Input
                id="console-filter"
                type="search"
                placeholder={messages.consoleFilterPlaceholder}
              />
            </h2>
            <ul id="console-list" className="signal-list"></ul>
          </Card>

          <Card data-log-panel-target="realtime">
            <h2>{messages.realtimeHeading}</h2>
            <ul id="realtime-list" className="signal-list"></ul>
          </Card>

          <Card data-log-panel-target="storage">
            <h2>{messages.storageHeading}</h2>
            <ul id="storage-list" className="signal-list"></ul>
          </Card>

          <Card data-log-panel-target="perf">
            <h2>{messages.performanceHeading}</h2>
            <ul id="perf-list" className="signal-list"></ul>
          </Card>
        </section>
      </section>

      <dialog id="share-upload-dialog" className="share-dialog">
        <form id="share-upload-form" className="share-dialog-card" method="dialog">
          <header className="share-dialog-head">
            <h2>{messages.shareArchiveTitle}</h2>
            <p>{messages.shareArchiveDescription}</p>
          </header>
          <label className="share-dialog-field">
            <span>{messages.shareServerUrl}</span>
            <Input
              id="share-upload-base-url"
              className="share-dialog-input"
              type="url"
              placeholder={messages.sharePlaceholderServerUrl}
              autoComplete="url"
            />
          </label>
          <label className="share-dialog-field">
            <span>{messages.shareOptionalPassphrase}</span>
            <Input
              id="share-upload-passphrase"
              className="share-dialog-input"
              type="password"
              placeholder={messages.sharePlaceholderPublicMetadata}
              autoComplete="off"
            />
          </label>
          <label className="share-dialog-field">
            <span>{messages.shareOptionalApiKey}</span>
            <Input
              id="share-upload-api-key"
              className="share-dialog-input"
              type="password"
              placeholder={messages.sharePlaceholderApiKeyRequired}
              autoComplete="off"
            />
          </label>
          <label className="share-dialog-toggle">
            <Checkbox id="share-upload-show-passphrase" />
            {messages.showPassphrase}
          </label>
          <section id="share-privacy-preflight" className="share-privacy-preflight">
            <header className="share-privacy-head">
              <h3>{messages.sharePrivacyPreflightTitle}</h3>
              <p>{messages.sharePrivacyPreflightDescription}</p>
            </header>
            <div className="share-privacy-grid">
              <div>
                <span>{messages.sharePrivacyRedactionProfile}</span>
                <strong id="share-privacy-profile"></strong>
              </div>
              <div>
                <span>{messages.sharePrivacyDetectedSignals}</span>
                <strong id="share-privacy-detected"></strong>
              </div>
              <div>
                <span>{messages.sharePrivacySensitivePreview}</span>
                <strong id="share-privacy-preview"></strong>
              </div>
            </div>
            <ul id="share-privacy-samples" className="share-privacy-samples"></ul>
            <label className="share-dialog-toggle">
              <Checkbox id="share-upload-privacy-reviewed" />
              {messages.sharePrivacyReviewed}
            </label>
          </section>
          <div className="share-dialog-actions">
            <Button id="share-upload-cancel" type="button" variant="ghost" data-dialog-cancel>
              {messages.cancel}
            </Button>
            <Button id="share-upload-confirm" type="submit" value="confirm" variant="secondary">
              {messages.share}
            </Button>
          </div>
        </form>
      </dialog>

      <dialog id="share-load-dialog" className="share-dialog">
        <form id="share-load-form" className="share-dialog-card" method="dialog">
          <header className="share-dialog-head">
            <h2>{messages.loadSharedArchiveTitle}</h2>
            <p>{messages.loadSharedArchiveDescription}</p>
          </header>
          <label className="share-dialog-field">
            <span>{messages.shareReference}</span>
            <Input
              id="share-load-reference"
              className="share-dialog-input"
              type="text"
              placeholder={messages.shareReferencePlaceholder}
              autoComplete="off"
            />
          </label>
          <label className="share-dialog-field">
            <span>{messages.shareOptionalApiKey}</span>
            <Input
              id="share-load-api-key"
              className="share-dialog-input"
              type="password"
              placeholder={messages.sharePlaceholderApiKeyRequired}
              autoComplete="off"
            />
          </label>
          <div className="share-dialog-actions">
            <Button id="share-load-cancel" type="button" variant="ghost" data-dialog-cancel>
              {messages.cancel}
            </Button>
            <Button id="share-load-confirm" type="submit" value="confirm" variant="secondary">
              {messages.load}
            </Button>
          </div>
        </form>
      </dialog>

      <dialog id="archive-passphrase-dialog" className="share-dialog">
        <form id="archive-passphrase-form" className="share-dialog-card" method="dialog">
          <header className="share-dialog-head">
            <h2>{messages.encryptedArchiveTitle}</h2>
            <p id="archive-passphrase-context">{messages.encryptedArchiveDescription}</p>
          </header>
          <label className="share-dialog-field">
            <span>{messages.passphrase}</span>
            <Input
              id="archive-passphrase-input"
              className="share-dialog-input"
              type="password"
              placeholder={messages.passphrasePlaceholder}
              autoComplete="off"
            />
          </label>
          <div className="share-dialog-actions">
            <Button id="archive-passphrase-cancel" type="button" variant="ghost" data-dialog-cancel>
              {messages.cancel}
            </Button>
            <Button
              id="archive-passphrase-confirm"
              type="submit"
              value="confirm"
              variant="secondary"
            >
              {messages.load}
            </Button>
          </div>
        </form>
      </dialog>

      <dialog id="playwright-preview-dialog" className="share-dialog">
        <form id="playwright-preview-form" className="share-dialog-card" method="dialog">
          <header className="share-dialog-head">
            <h2>{messages.playwrightPreviewTitle}</h2>
            <p>{messages.playwrightPreviewDescription}</p>
          </header>
          <div className="playwright-preview-grid">
            <label className="share-dialog-field">
              <span>{messages.playwrightRangeStart}</span>
              <Input
                id="playwright-range-start"
                className="share-dialog-input"
                type="number"
                min="0"
                step="0.1"
                defaultValue="0"
              />
            </label>
            <label className="share-dialog-field">
              <span>{messages.playwrightRangeEnd}</span>
              <Input
                id="playwright-range-end"
                className="share-dialog-input"
                type="number"
                min="0"
                step="0.1"
                defaultValue="0"
              />
            </label>
            <label className="share-dialog-field">
              <span>{messages.playwrightMaxActions}</span>
              <Input
                id="playwright-max-actions"
                className="share-dialog-input"
                type="number"
                min="1"
                max="500"
                step="1"
                defaultValue="40"
              />
            </label>
          </div>
          <label className="share-dialog-toggle">
            <Checkbox id="playwright-include-har" defaultChecked />
            {messages.playwrightIncludeHarReplay}
          </label>
          <textarea
            id="playwright-script-preview"
            className="playwright-script-preview"
            spellCheck={false}
          ></textarea>
          <div className="share-dialog-actions">
            <Button id="playwright-refresh" type="button" variant="ghost">
              {messages.regenerate}
            </Button>
            <Button id="playwright-copy" type="button" variant="secondary">
              {messages.copy}
            </Button>
            <Button id="playwright-download" type="button" variant="secondary">
              {messages.download}
            </Button>
            <Button id="playwright-close" type="button" variant="ghost" data-dialog-cancel>
              {messages.close}
            </Button>
          </div>
        </form>
      </dialog>

      <div id="archive-drop-overlay" className="archive-drop-overlay" hidden>
        <div className="archive-drop-overlay-card">
          <strong>{messages.dropArchiveToLoad}</strong>
          <span className="mono">{messages.dropArchiveSupport}</span>
        </div>
      </div>
    </main>
  );
}
