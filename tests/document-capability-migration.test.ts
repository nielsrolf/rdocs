import assert from "node:assert/strict";
import { test } from "node:test";

import { DOCUMENT_VERSION_MIGRATION_PAGE_SIZE } from "../lib/document-capability-migration";

test("security migration keeps DocumentVersion content pages below Prisma's native string limit", () => {
  assert.ok(
    DOCUMENT_VERSION_MIGRATION_PAGE_SIZE <= 10,
    `content migration page is ${DOCUMENT_VERSION_MIGRATION_PAGE_SIZE}; large histories overflow Prisma's native string bridge`
  );
});
