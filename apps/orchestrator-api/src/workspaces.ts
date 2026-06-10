import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".runtime",
  "dist",
  "node_modules",
  "target"
]);

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export type WorkspaceEntry = {
  name: string;
  relativePath: string;
  parentPath: string | null;
  kind: "file" | "directory";
  depth: number;
  size: number | null;
  modifiedAt: string | null;
  skipped: boolean;
};

export type WorkspaceGitChange = {
  status: string;
  path: string;
};

function normalizeRelativePath(value: string) {
  return value.split(path.sep).join("/");
}

function resolveInsideRoot(rootPath: string, subpath = ".") {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, subpath || ".");
  const relative = path.relative(root, target);

  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new WorkspacePathError("workspace_path_outside_root");
  }

  return {
    root,
    target,
    relative: relative ? normalizeRelativePath(relative) : ""
  };
}

async function statDirectory(rootPath: string) {
  const root = path.resolve(rootPath);
  let stats;
  try {
    stats = await fs.stat(root);
  } catch {
    throw new WorkspacePathError("workspace_not_found");
  }

  if (!stats.isDirectory()) {
    throw new WorkspacePathError("workspace_not_directory");
  }

  return {
    root,
    stats
  };
}

async function runGit(rootPath: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", rootPath, ...args], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function parseGitChanges(statusOutput: string): WorkspaceGitChange[] {
  return statusOutput
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("## "))
    .slice(0, 200)
    .map((line) => ({
      status: line.slice(0, 2).trim() || "??",
      path: line.slice(3).trim()
    }));
}

export async function getWorkspaceGitStatus(rootPath: string) {
  const { root } = await statDirectory(rootPath);
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    return {
      rootPath: root,
      isRepo: false,
      branch: null,
      head: null,
      dirty: false,
      changeCount: 0,
      changes: [] as WorkspaceGitChange[]
    };
  }

  const [branchOutput, headOutput, statusOutput] = await Promise.all([
    runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(root, ["rev-parse", "--short", "HEAD"]),
    runGit(root, ["status", "--porcelain=v1", "-b"])
  ]);
  const changes = parseGitChanges(statusOutput ?? "");
  const branch = branchOutput && branchOutput !== "HEAD" ? branchOutput : null;

  return {
    rootPath: root,
    isRepo: true,
    branch,
    head: headOutput || null,
    dirty: changes.length > 0,
    changeCount: changes.length,
    changes
  };
}

export async function inspectWorkspace(rootPath: string) {
  const { root, stats } = await statDirectory(rootPath);
  const git = await getWorkspaceGitStatus(root);

  return {
    rootPath: root,
    exists: true,
    isDirectory: true,
    modifiedAt: stats.mtime.toISOString(),
    git: {
      isRepo: git.isRepo,
      branch: git.branch,
      head: git.head,
      dirty: git.dirty,
      changeCount: git.changeCount
    }
  };
}

export async function listWorkspaceFiles(
  rootPath: string,
  input: {
    subpath?: string;
    depth?: number;
    limit?: number;
    includeHidden?: boolean;
  } = {}
) {
  const { root } = await statDirectory(rootPath);
  const { target, relative } = resolveInsideRoot(root, input.subpath ?? ".");
  const targetStats = await fs.stat(target);
  if (!targetStats.isDirectory()) {
    throw new WorkspacePathError("workspace_target_not_directory");
  }

  const maxDepth = Math.min(Math.max(input.depth ?? 3, 0), 8);
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);
  const includeHidden = input.includeHidden ?? false;
  const entries: WorkspaceEntry[] = [];
  let truncated = false;

  const pushEntry = (entry: WorkspaceEntry) => {
    if (entries.length >= limit) {
      truncated = true;
      return false;
    }
    entries.push(entry);
    return true;
  };

  const walk = async (directoryPath: string, currentRelative: string, currentDepth: number) => {
    if (currentDepth > maxDepth || truncated) {
      return;
    }

    const dirents = await fs.readdir(directoryPath, { withFileTypes: true });
    dirents.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    for (const dirent of dirents) {
      if (truncated) {
        break;
      }
      if (!includeHidden && dirent.name.startsWith(".")) {
        continue;
      }

      const absolutePath = path.join(directoryPath, dirent.name);
      const childRelative = currentRelative
        ? normalizeRelativePath(path.join(currentRelative, dirent.name))
        : dirent.name;
      const isDirectory = dirent.isDirectory();
      const skipped = isDirectory && DEFAULT_EXCLUDED_DIRECTORIES.has(dirent.name);
      let stats = null;
      try {
        stats = await fs.stat(absolutePath);
      } catch {
        continue;
      }

      const accepted = pushEntry({
        name: dirent.name,
        relativePath: childRelative,
        parentPath: currentRelative || null,
        kind: isDirectory ? "directory" : "file",
        depth: currentDepth,
        size: isDirectory ? null : stats.size,
        modifiedAt: stats.mtime.toISOString(),
        skipped
      });
      if (!accepted) {
        break;
      }

      if (isDirectory && !skipped) {
        await walk(absolutePath, childRelative, currentDepth + 1);
      }
    }
  };

  await walk(target, relative, 0);

  return {
    rootPath: root,
    subpath: relative,
    depth: maxDepth,
    limit,
    truncated,
    entries
  };
}

export async function readWorkspaceFile(
  rootPath: string,
  input: {
    subpath: string;
    maxBytes?: number;
  }
) {
  const { root } = await statDirectory(rootPath);
  const { target, relative } = resolveInsideRoot(root, input.subpath);
  const stats = await fs.stat(target);
  if (!stats.isFile()) {
    throw new WorkspacePathError("workspace_target_not_file");
  }

  const maxBytes = Math.min(Math.max(input.maxBytes ?? 256 * 1024, 1), 1024 * 1024);
  const bytesToRead = Math.min(stats.size, maxBytes);
  const handle = await fs.open(target, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    const binary = buffer.includes(0);

    return {
      rootPath: root,
      relativePath: relative,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      maxBytes,
      truncated: stats.size > maxBytes,
      binary,
      encoding: binary ? null : "utf8",
      content: binary ? null : buffer.toString("utf8")
    };
  } finally {
    await handle.close();
  }
}
