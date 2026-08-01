"use strict";

const { spawnSync } = require("child_process");

class GitCommitter {
  constructor(workDir, branch = "cron-state") {
    this.workDir = workDir;
    this.branch = branch;
  }

  git(args, options = {}) {
    const result = spawnSync("git", args, {
      cwd: this.workDir,
      encoding: "utf8",
      ...options,
    });
    if (result.status !== 0 && options.check !== false) {
      throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
    }
    return result;
  }

  commitAndPush(paths, message) {
    if (!paths.length) return false;
    this.git(["add", ...paths]);
    const diff = this.git(["diff", "--cached", "--quiet"], { check: false });
    if (diff.status === 0) return false;
    this.git(["commit", "-m", message]);
    this.git(["push", "origin", `HEAD:${this.branch}`]);
    return true;
  }
}

module.exports = { GitCommitter };
