import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("native desktop delivery uses verified atomic file replacement", async () => {
  const source = await readFile(
    path.resolve("apps/desktop-app/src-tauri/src/main.rs"),
    "utf8"
  );
  assert.match(source, /OpenOptions::new\(\)[\s\S]*?\.create_new\(true\)/);
  assert.match(source, /output\.sync_all\(\)/);
  assert.match(source, /fs::rename\(&temporary, &target\)/);
  assert.match(source, /checksum_sha256/);
  assert.match(source, /download_size_mismatch/);
  assert.match(source, /fs::remove_file\(&temporary\)/);
  assert.match(source, /cleanup_stale_delivery_parts/);
});
