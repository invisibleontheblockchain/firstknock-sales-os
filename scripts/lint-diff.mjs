#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function diagnosticKey(diagnostic) {
  return JSON.stringify([
    diagnostic.filePath,
    diagnostic.ruleId ?? "<fatal>",
    diagnostic.severity,
    diagnostic.message,
  ]);
}

function flattenReport(report, reportRoot) {
  return report.flatMap((fileResult) => {
    const relativePath = normalizePath(path.relative(reportRoot, fileResult.filePath));

    return fileResult.messages.map((message) => ({
      filePath: relativePath,
      ruleId: message.ruleId,
      severity: message.severity,
      message: message.message,
      line: message.line ?? 0,
      column: message.column ?? 0,
    }));
  });
}

export function compareLintReports(
  baselineReport,
  headReport,
  { baselineRoot, headRoot },
) {
  const baselineDiagnostics = flattenReport(baselineReport, baselineRoot);
  const headDiagnostics = flattenReport(headReport, headRoot);
  const unmatchedBaseline = new Map();

  for (const diagnostic of baselineDiagnostics) {
    const key = diagnosticKey(diagnostic);
    unmatchedBaseline.set(key, (unmatchedBaseline.get(key) ?? 0) + 1);
  }

  const newDiagnostics = [];
  for (const diagnostic of headDiagnostics) {
    const key = diagnosticKey(diagnostic);
    const remaining = unmatchedBaseline.get(key) ?? 0;

    if (remaining > 0) {
      unmatchedBaseline.set(key, remaining - 1);
    } else {
      newDiagnostics.push(diagnostic);
    }
  }

  const resolvedCount = [...unmatchedBaseline.values()].reduce(
    (total, count) => total + count,
    0,
  );

  return {
    baselineDiagnostics,
    headDiagnostics,
    newDiagnostics,
    resolvedCount,
  };
}

function parseArguments(argv) {
  const values = {
    base: null,
    head: "HEAD",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--base" || argument === "--head") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a Git revision.`);
      }

      values[argument.slice(2)] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!values.base) {
    throw new Error("Usage: node scripts/lint-diff.mjs --base <revision> [--head <revision>]");
  }

  return values;
}

function runGit(repositoryRoot, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? result.stderr.trim() : "";
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  return result;
}

function resolveRepositoryRoot() {
  const result = runGit(process.cwd(), ["rev-parse", "--show-toplevel"], {
    capture: true,
  });

  return path.resolve(result.stdout.trim());
}

function resolveMergeBase(repositoryRoot, baseRevision, headRevision) {
  const result = runGit(
    repositoryRoot,
    ["merge-base", baseRevision, headRevision],
    { capture: true },
  );
  const mergeBase = result.stdout.trim();

  if (!/^[0-9a-f]{40}$/i.test(mergeBase)) {
    throw new Error(`Git returned an invalid merge-base SHA: ${mergeBase}`);
  }

  return mergeBase;
}

function runEslint(repositoryRoot, outputPath, eslintBinaryPath) {
  const result = spawnSync(
    process.execPath,
    [eslintBinaryPath, ".", "--format", "json", "--output-file", outputPath],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }

  // ESLint uses 1 for ordinary lint findings and 2 for configuration/internal
  // failures. Findings are compared below; infrastructure failures must fail closed.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `ESLint failed to produce a trustworthy report in ${repositoryRoot} (exit ${result.status}).`,
    );
  }

  if (!existsSync(outputPath)) {
    throw new Error(`ESLint did not create its JSON report: ${outputPath}`);
  }
}

function installLockedBaselineDependencies(baselineWorktree) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: baselineWorktree,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Locked baseline dependency installation failed (exit ${result.status}).`,
    );
  }
}

function countBySeverity(diagnostics) {
  return diagnostics.reduce(
    (counts, diagnostic) => {
      if (diagnostic.severity === 2) {
        counts.errors += 1;
      } else if (diagnostic.severity === 1) {
        counts.warnings += 1;
      }
      return counts;
    },
    { errors: 0, warnings: 0 },
  );
}

function printSummary(mergeBase, comparison) {
  const baselineCounts = countBySeverity(comparison.baselineDiagnostics);
  const headCounts = countBySeverity(comparison.headDiagnostics);

  console.log("Diff-aware ESLint comparison");
  console.log(`  merge base: ${mergeBase}`);
  console.log(
    `  baseline: ${baselineCounts.errors} error(s), ${baselineCounts.warnings} warning(s)`,
  );
  console.log(
    `  head:     ${headCounts.errors} error(s), ${headCounts.warnings} warning(s)`,
  );
  console.log(`  resolved diagnostics: ${comparison.resolvedCount}`);
  console.log(`  net-new diagnostics:  ${comparison.newDiagnostics.length}`);

  if (comparison.newDiagnostics.length === 0) {
    console.log("No net-new ESLint diagnostics were introduced.");
    return;
  }

  console.error("\nNet-new ESLint diagnostics:");
  for (const diagnostic of comparison.newDiagnostics) {
    const severity = diagnostic.severity === 2 ? "error" : "warning";
    console.error(
      `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} ${severity} ${diagnostic.ruleId ?? "<fatal>"} ${diagnostic.message}`,
    );
  }
}

async function main() {
  const { base, head } = parseArguments(process.argv.slice(2));
  const repositoryRoot = resolveRepositoryRoot();
  const mergeBase = resolveMergeBase(repositoryRoot, base, head);
  const headEslintBinaryPath = path.join(
    repositoryRoot,
    "node_modules",
    "eslint",
    "bin",
    "eslint.js",
  );

  if (!existsSync(headEslintBinaryPath)) {
    throw new Error("ESLint is not installed. Run npm ci before diff-aware lint.");
  }

  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "firstknock-lint-diff-"),
  );
  const baselineWorktree = path.join(temporaryRoot, "baseline");
  const baselineReportPath = path.join(temporaryRoot, "baseline-eslint.json");
  const headReportPath = path.join(temporaryRoot, "head-eslint.json");
  let worktreeCreated = false;

  try {
    runGit(repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      baselineWorktree,
      mergeBase,
    ]);
    worktreeCreated = true;

    installLockedBaselineDependencies(baselineWorktree);
    const baselineEslintBinaryPath = path.join(
      baselineWorktree,
      "node_modules",
      "eslint",
      "bin",
      "eslint.js",
    );

    if (!existsSync(baselineEslintBinaryPath)) {
      throw new Error(
        "The merge-base lockfile did not install its declared ESLint binary.",
      );
    }

    runEslint(
      baselineWorktree,
      baselineReportPath,
      baselineEslintBinaryPath,
    );
    runEslint(repositoryRoot, headReportPath, headEslintBinaryPath);

    const baselineReport = JSON.parse(
      readFileSync(baselineReportPath, "utf8"),
    );
    const headReport = JSON.parse(readFileSync(headReportPath, "utf8"));
    const comparison = compareLintReports(baselineReport, headReport, {
      baselineRoot: baselineWorktree,
      headRoot: repositoryRoot,
    });

    printSummary(mergeBase, comparison);
    if (comparison.newDiagnostics.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (worktreeCreated) {
      const removal = runGit(
        repositoryRoot,
        ["worktree", "remove", "--force", baselineWorktree],
        { allowFailure: true },
      );

      if (removal.status !== 0) {
        runGit(
          repositoryRoot,
          ["worktree", "remove", "--force", "--force", baselineWorktree],
          { allowFailure: true },
        );
      }
    }

    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Diff-aware lint failed: ${error.message}`);
    process.exitCode = 2;
  });
}
