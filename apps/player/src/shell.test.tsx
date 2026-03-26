/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { PlayerShell } from "./shell.js";

afterEach(() => {
  cleanup();
});

describe("PlayerShell", () => {
  it("renders core loading and playback controls", () => {
    render(<PlayerShell />);

    const archiveInput = screen.getByLabelText("Load Archive");
    const compareInput = screen.getByLabelText("Load Compare");
    const repoLink = screen.getByRole("link", { name: "GitHub Repo" });
    const localeSelect = screen.getByLabelText("Language");
    const playbackRate = screen.getByLabelText("Speed");
    const playerVersion = screen.getByLabelText("Player version");
    const stagePlaceholder = document.querySelector("#stage-placeholder");

    expect(archiveInput).toHaveAttribute("type", "file");
    expect(archiveInput).toHaveAttribute("accept", ".webblackbox,.zip");
    expect(compareInput).toHaveAttribute("type", "file");
    expect(compareInput).toHaveAttribute("accept", ".webblackbox,.zip");
    expect(repoLink).toHaveAttribute("href", "https://github.com/webllm/webblackbox");
    expect(localeSelect).toHaveValue("en");
    expect(playerVersion).toHaveTextContent("v0.1.0");
    expect(stagePlaceholder?.tagName).toBe("LABEL");
    expect(stagePlaceholder).toHaveAttribute("for", "archive-input");

    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "-1s" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+1s" })).toBeInTheDocument();
    expect(playbackRate).toHaveValue("1");
  });

  it("renders Chinese labels when locale is zh-CN", () => {
    render(<PlayerShell locale="zh-CN" />);

    expect(screen.getByLabelText("语言")).toHaveValue("zh-CN");
    expect(screen.getByLabelText("加载归档")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "时间线" })).toBeInTheDocument();
    expect(screen.getByText("复制 cURL")).toBeInTheDocument();
  });

  it("supports key UI interactions for triage and playback controls", async () => {
    const user = userEvent.setup();
    render(<PlayerShell />);

    const quickTriageInput = screen.getByRole("spinbutton");
    const maskCheckbox = screen.getByLabelText("Mask response preview");
    const playbackRate = screen.getByLabelText("Speed");

    await user.clear(quickTriageInput);
    await user.type(quickTriageInput, "25");
    await user.click(maskCheckbox);
    await user.selectOptions(playbackRate, "2");

    expect(quickTriageInput).toHaveValue(25);
    expect(maskCheckbox).not.toBeChecked();
    expect(playbackRate).toHaveValue("2");
  });

  it("renders timeline, network, and console panels with expected controls", () => {
    render(<PlayerShell />);

    const tablist = screen.getByRole("tablist", { name: "Log panels" });
    expect(tablist).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Event" })).toHaveClass("active");
    expect(screen.getByRole("heading", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Network" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Console" })).toBeInTheDocument();
    expect(document.querySelector("#timeline-list")).toBeInTheDocument();
    expect(document.querySelector("#waterfall-body")).toBeInTheDocument();
    expect(document.querySelector("#console-list")).toBeInTheDocument();

    expect(screen.getByText("Copy cURL")).toBeInTheDocument();
    expect(screen.getByText("Replay request")).toBeInTheDocument();
    expect(screen.getByText("0 / 0 requests")).toBeInTheDocument();
  });

  it("supports network and console filter interactions", async () => {
    const user = userEvent.setup();
    render(<PlayerShell />);

    const networkSearch = screen.getByPlaceholderText("Filter URL, host, id, method");
    const scopeFilter = document.querySelector("#scope-filter");
    const methodFilter = document.querySelector("#network-method-filter");
    const statusFilter = document.querySelector("#network-status-filter");
    const typeFilter = document.querySelector("#network-type-filter");
    const networkScopeFilter = document.querySelector("#network-scope-filter");
    const consoleSearch = screen.getByPlaceholderText("Filter logs by type or content");

    if (!(scopeFilter instanceof HTMLSelectElement)) {
      throw new Error("Expected #scope-filter to be a select element");
    }
    if (!(methodFilter instanceof HTMLSelectElement)) {
      throw new Error("Expected #network-method-filter to be a select element");
    }
    if (!(statusFilter instanceof HTMLSelectElement)) {
      throw new Error("Expected #network-status-filter to be a select element");
    }
    if (!(typeFilter instanceof HTMLSelectElement)) {
      throw new Error("Expected #network-type-filter to be a select element");
    }
    if (!(networkScopeFilter instanceof HTMLSelectElement)) {
      throw new Error("Expected #network-scope-filter to be a select element");
    }

    await user.type(networkSearch, "api/orders");
    await user.selectOptions(scopeFilter, "iframe");
    await user.selectOptions(methodFilter, "POST");
    await user.selectOptions(statusFilter, "server-error");
    await user.selectOptions(typeFilter, "fetch");
    await user.selectOptions(networkScopeFilter, "iframe");
    await user.type(consoleSearch, "timeout");

    expect(networkSearch).toHaveValue("api/orders");
    expect(scopeFilter).toHaveValue("iframe");
    expect(methodFilter).toHaveValue("POST");
    expect(statusFilter).toHaveValue("server-error");
    expect(typeFilter).toHaveValue("fetch");
    expect(networkScopeFilter).toHaveValue("iframe");
    expect(consoleSearch).toHaveValue("timeout");
  });
});
