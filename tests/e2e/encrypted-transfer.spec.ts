import { expect, test } from "@playwright/test";
import { openTwoPeers } from "@baditaflorin/mesh-common/testing";

test("a matching room secret reveals an encrypted drop to another peer", async ({
  browser,
  baseURL,
}) => {
  const { a, b, cleanup } = await openTwoPeers(browser, baseURL ?? "", {
    storagePrefix: "mesh-privacy-drop",
  });
  try {
    const secret = "cafe-babe-dead-beef-face-feed";
    await a.getByLabel("Room secret").fill(secret);
    await b.getByLabel("Room secret").fill(secret);
    await a.locator('input[type="file"]').setInputFiles({
      name: "hello-private.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Encrypted before replication."),
    });
    await expect(a.getByRole("button", { name: "Encrypt & send" })).toBeEnabled();
    await a.getByRole("button", { name: "Encrypt & send" }).click();
    await expect(b.getByText("hello-private.txt")).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanup();
  }
});
