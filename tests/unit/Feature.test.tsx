import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMockRoom } from "@baditaflorin/mesh-common/testing";
import { createDropPassphrase, Feature, formatBytes, isExpired } from "../../src/Feature";
import { config } from "../../src/config";

describe("Feature (component)", () => {
  it("renders the encrypted drop flow when connected", () => {
    const room = createMockRoom();
    render(<Feature room={room} config={config} />);
    expect(screen.getByRole("heading", { name: /Pass a file/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Encrypt & send/i })).toBeDisabled();
  });

  it("shows a connecting state when room is null", () => {
    render(<Feature room={null} config={config} />);
    expect(screen.getByText(/Connecting to room/i)).toBeInTheDocument();
  });

  it("creates a readable non-empty secret and formats expiry helpers", () => {
    expect(createDropPassphrase()).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/);
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(isExpired(100, 101)).toBe(true);
    expect(isExpired(101, 100)).toBe(false);
  });
});
