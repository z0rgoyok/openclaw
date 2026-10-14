// HTML delivery through the real outbound host reader and existing root boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildOutboundMediaLoadOptions } from "./load-options.js";

let loadWebMedia: typeof import("./web-media.js").loadWebMedia;
beforeAll(async () => {
  ({ loadWebMedia } = await import("./web-media.js"));
});

describe("authorized workspace HTML", () => {
  it("loads authorized workspace HTML through the outbound host reader", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-agent-workspace-"));
    const htmlFile = path.join(root, "schedule.html");
    const contents = Buffer.from("<!doctype html><title>Schedule</title><body>ISABELL</body>\n");
    await fs.writeFile(htmlFile, contents);
    try {
      const result = await loadWebMedia(
        htmlFile,
        buildOutboundMediaLoadOptions({
          mediaAccess: {
            localRoots: [root],
            readFile: async (sourcePath) => await fs.readFile(sourcePath),
          },
        }),
      );
      expect(result.buffer).toEqual(contents);
      expect(result.fileName).toBe("schedule.html");
      expect(result.contentType).toBe("text/html");
      expect(result.trustedGeneratedHtmlSource).toBe(true);
      await expect(
        loadWebMedia(htmlFile, {
          localRoots: [root],
          hostReadCapability: true,
        }),
      ).rejects.toMatchObject({ code: "path-not-allowed" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects workspace HTML outside declared roots before invoking the reader", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-agent-workspace-"));
    const htmlFile = path.join(root, "schedule.html");
    await fs.writeFile(htmlFile, "<!doctype html><body>Schedule</body>\n");
    const readFile = vi.fn(async (sourcePath: string) => await fs.readFile(sourcePath));
    await fs.mkdir(path.join(root, "allowed"));
    try {
      await expect(
        loadWebMedia(
          htmlFile,
          buildOutboundMediaLoadOptions({
            mediaAccess: { localRoots: [path.join(root, "allowed")], readFile },
          }),
        ),
      ).rejects.toMatchObject({ code: "path-not-allowed" });
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["symlink", "hardlink"])(
    "rejects %s HTML inside an authorized workspace",
    async (kind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-media-agent-workspace-"));
      const source = path.join(root, "source.html");
      const linked = path.join(root, "schedule.html");
      await fs.writeFile(source, "<!doctype html><body>Schedule</body>\n");
      const readFile = vi.fn(async (sourcePath: string) => await fs.readFile(sourcePath));
      try {
        if (kind === "symlink") {
          await fs.symlink(source, linked);
        } else {
          await fs.link(source, linked);
        }
        await expect(
          loadWebMedia(
            linked,
            buildOutboundMediaLoadOptions({
              mediaAccess: { localRoots: [root], readFile },
            }),
          ),
        ).rejects.toMatchObject({ code: "path-not-allowed" });
        expect(readFile).not.toHaveBeenCalled();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
