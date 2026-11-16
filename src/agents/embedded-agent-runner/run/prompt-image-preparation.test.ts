import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";

describe("prepareEmbeddedAttemptPromptExecution", () => {
  it("lets a workspace-only generated-media completion turn read the file it delivers", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pip-ws-"));
    const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pip-media-"));
    const imagePath = path.join(mediaDir, "generated.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      // Production composition: the attempt's internalDeliveryMediaUrls must reach prompt
      // image discovery, otherwise the workspace-only read of the generated file is rejected.
      const result = await prepareEmbeddedAttemptPromptExecution({
        attempt: {
          model: { input: ["text", "image"] },
          internalDeliveryMediaUrls: [imagePath],
        },
        mediaOwnerAgentId: "main",
        effectiveFsWorkspaceOnly: true,
        effectiveWorkspace: workspaceDir,
        prompt: `Attachments:\n1. type=image path="${imagePath}"\n\nGenerated media:\nMEDIA:${imagePath}`,
        skipPromptSubmission: false,
      });
      expect(result.images).toHaveLength(1);
      expect(result.loadedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(mediaDir, { recursive: true, force: true });
    }
  });
});
