/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
});
