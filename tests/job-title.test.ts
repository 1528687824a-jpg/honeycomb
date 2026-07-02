import assert from "node:assert/strict";
import test from "node:test";
import {
  inferJobDisplayTitle,
  userTaskPrompt
} from "../packages/shared/src/job-title";

const teaPosterPrompt =
  "\u5e2e\u6211\u505a\u4e00\u4e2a\u5ba3\u4f20\u6d77\u62a5\u53ef\u4ee5\u5417\uff1f\u4e3b\u9898\u662f\u8336\u9053\uff0c\u6d77\u62a5\u653e\u5728\u684c\u9762\u4e0a\u5c31\u884c\u4e86\uff0c1080\u00d71920\uff0c\u53e4\u5178\u534e\u7f8e\uff0c\u6d77\u62a5\u4e0a\u4e0d\u7528\u6709\u5b57\uff0cPNG\u683c\u5f0f\u8f93\u51fa\u5c31\u884c";

test("inferJobDisplayTitle derives a concise task title from a poster prompt", () => {
  assert.equal(inferJobDisplayTitle(teaPosterPrompt), "\u8336\u9053\u5ba3\u4f20\u6d77\u62a5");
});

test("inferJobDisplayTitle ignores appended Honeycomb workbench context", () => {
  const promptWithContext = [
    teaPosterPrompt,
    "",
    "[Honeycomb supervisor workbench context]",
    "Available skills: writing, image, video, review"
  ].join("\n");

  assert.equal(userTaskPrompt(promptWithContext), teaPosterPrompt);
  assert.equal(inferJobDisplayTitle(promptWithContext), "\u8336\u9053\u5ba3\u4f20\u6d77\u62a5");
});
