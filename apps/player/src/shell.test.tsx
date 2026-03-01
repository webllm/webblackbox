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
    const playbackRate = screen.getByLabelText("Speed");

    expect(archiveInput).toHaveAttribute("type", "file");
    expect(archiveInput).toHaveAttribute("accept", ".webblackbox,.zip");
    expect(compareInput).toHaveAttribute("type", "file");
    expect(compareInput).toHaveAttribute("accept", ".webblackbox,.zip");

    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "-1s" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+1s" })).toBeInTheDocument();
    expect(playbackRate).toHaveValue("1");
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
    const methodFilter = document.querySelector("#network-method-filter");
    const statusFilter = document.querySelector("#network-status-filter");
    const typeFilter = document.querySelector("#network-type-filter");
    const consoleSearch = screen.getByPlaceholderText("Filter logs by type or content");

    if (!(methodFilter instanceof HTMLSelectElement)) {
      throw new Error("Expected #network-method-filter to be a select element");
    }
    if (!(statusFilter instanceof HTMLSelectElement)) {
      throw new Error("Expected #network-status-filter to be a select element");
    }
    if (!(typeFilter instanceof HTMLSelectElement)) {
      throw new Error("Expected #network-type-filter to be a select element");
    }

    await user.type(networkSearch, "api/orders");
    await user.selectOptions(methodFilter, "POST");
    await user.selectOptions(statusFilter, "server-error");
    await user.selectOptions(typeFilter, "fetch");
    await user.type(consoleSearch, "timeout");

    expect(networkSearch).toHaveValue("api/orders");
    expect(methodFilter).toHaveValue("POST");
    expect(statusFilter).toHaveValue("server-error");
    expect(typeFilter).toHaveValue("fetch");
    expect(consoleSearch).toHaveValue("timeout");
  });
});
