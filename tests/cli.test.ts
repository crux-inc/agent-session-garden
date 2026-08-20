import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";

test("CLI browser opening is opt-in", () => {
  assert.equal(parseArgs([]).open, false);
  assert.equal(parseArgs(["--open"]).open, true);
});
