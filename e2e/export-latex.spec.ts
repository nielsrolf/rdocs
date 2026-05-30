import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { serializeDocumentContent } from "../lib/content";
import { db } from "../lib/db";
import { authenticate, cleanupFixture } from "./helpers";

// A 1x1 transparent PNG as a data URL — exercises image embedding into the zip.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("Overleaf export returns a zip with compilable main.tex and embedded images", async ({
  baseURL,
  browser
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const user = await db.user.create({
    data: { email: `export-${crypto.randomUUID()}@example.com`, name: "Export User", passwordHash: "x" }
  });
  const content = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Results 100% complete" }] },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Significant at p < 0.05 & robust." }]
      },
      { type: "image", attrs: { src: PNG_DATA_URL, alt: "tiny figure" } }
    ]
  };
  const document = await db.document.create({
    data: { title: "My Paper & Notes", content: serializeDocumentContent(content), ownerId: user.id }
  });

  const context = await browser.newContext();
  try {
    await authenticate(context, baseURL, user.id);
    const response = await context.request.get(`/api/documents/${document.id}/export?format=latex`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/zip");
    expect(response.headers()["content-disposition"]).toContain(".zip");

    const dir = mkdtempSync(path.join(tmpdir(), "export-"));
    try {
      const zipPath = path.join(dir, "export.zip");
      writeFileSync(zipPath, Buffer.from(await response.body()));
      // System unzip validates the archive (CRCs + central directory).
      execFileSync("unzip", ["-o", zipPath, "-d", dir], { stdio: "ignore" });

      const tex = readFileSync(path.join(dir, "main.tex"), "utf8");
      expect(tex).toContain("\\documentclass");
      expect(tex).toContain("\\title{My Paper \\& Notes}");
      expect(tex).toContain("\\section{Results 100\\% complete}");
      // The data-URL image is embedded and referenced.
      expect(tex).toMatch(/\\includegraphics\[width=0\.8\\linewidth\]\{images\/fig-1\.png\}/);
      const figure = readFileSync(path.join(dir, "images/fig-1.png"));
      expect(figure.length).toBeGreaterThan(0);
      // PNG magic bytes confirm the embedded file is the decoded image.
      expect(figure.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await context.close();
    await cleanupFixture(user.id, document.id);
  }
});
