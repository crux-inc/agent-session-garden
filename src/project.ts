import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

export async function detectProjectRoot(launchDirectory = process.cwd()): Promise<string> {
  const launch = await realpath(path.resolve(launchDirectory));
  try {
    const { stdout } = await exec("git", ["-C", launch, "rev-parse", "--show-toplevel"]);
    return realpath(stdout.trim());
  } catch {
    return launch;
  }
}

function resolveExistingPath(value: string): string {
  try {
    return realpathSync(path.resolve(value));
  } catch {
    return path.resolve(value);
  }
}

export function isProjectPath(projectRoot: string, candidate: string): boolean {
  const root = resolveExistingPath(projectRoot);
  const value = resolveExistingPath(candidate);
  return value === root || value.startsWith(`${root}${path.sep}`);
}
