import test from "node:test";
import assert from "node:assert/strict";
import { detectProjectRoot, isProjectPath } from "../src/project.js";

test("detects the repository root from a nested directory", async () => {
  const root = await detectProjectRoot(new URL("..", import.meta.url).pathname);
  assert.equal(root, process.cwd());
});

test("uses path segments when checking project descendants", () => {
  assert.equal(isProjectPath("/tmp/project", "/tmp/project/src"), true);
  assert.equal(isProjectPath("/tmp/project", "/tmp/project-other"), false);
});
