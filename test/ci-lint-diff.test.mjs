import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compareLintReports } from "../scripts/lint-diff.mjs";

const lintDiffScript = fileURLToPath(
  new URL("../scripts/lint-diff.mjs", import.meta.url),
);

function report(root, file, messages) {
  return [
    {
      filePath: `${root}/${file}`,
      messages,
    },
  ];
}

function diagnostic({
  ruleId = "example/rule",
  severity = 2,
  message,
  line = 1,
  column = 1,
}) {
  return {
    ruleId,
    severity,
    message,
    line,
    column,
  };
}

function run(command, args, cwd, { allowFailure = false } = {}) {
  const isWindowsCommand = process.platform === "win32" && command.endsWith(".cmd");
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: isWindowsCommand,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    assert.fail(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }

  return result;
}

function runGit(repositoryRoot, ...args) {
  return run("git", args, repositoryRoot);
}

function runNpm(repositoryRoot, ...args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(command, args, repositoryRoot);
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fakeEslintSource(messages) {
  return `
const fs = require("node:fs");
const path = require("node:path");

const outputIndex = process.argv.indexOf("--output-file");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  process.stderr.write("missing --output-file");
  process.exit(2);
}

const messages = ${JSON.stringify(messages)};
const report = [{
  filePath: path.join(process.cwd(), "fixture.js"),
  messages,
  errorCount: messages.filter((message) => message.severity === 2).length,
  warningCount: messages.filter((message) => message.severity === 1).length,
}];

fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify(report));
process.exit(report[0].errorCount > 0 ? 1 : 0);
`.trimStart();
}

function writeLocalEslintFixture(
  repositoryRoot,
  { version, messages, includeLockfile },
) {
  const packageRoot = path.join(repositoryRoot, "fake-eslint");
  const packageBin = path.join(packageRoot, "bin");
  mkdirSync(packageBin, { recursive: true });

  writeJson(path.join(repositoryRoot, "package.json"), {
    name: "lint-diff-integration-fixture",
    version: "1.0.0",
    private: true,
    devDependencies: {
      eslint: "file:fake-eslint",
    },
  });
  writeJson(path.join(packageRoot, "package.json"), {
    name: "eslint",
    version,
  });
  writeFileSync(
    path.join(packageBin, "eslint.js"),
    fakeEslintSource(messages),
    "utf8",
  );
  writeFileSync(path.join(repositoryRoot, "fixture.js"), "\n", "utf8");

  if (includeLockfile) {
    runNpm(
      repositoryRoot,
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    );
  }
}

function initializeRepository(prefix) {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), prefix));
  runGit(repositoryRoot, "init");
  runGit(repositoryRoot, "config", "user.name", "CI Test");
  runGit(repositoryRoot, "config", "user.email", "ci-test@example.invalid");
  return repositoryRoot;
}

function commitAll(repositoryRoot, message) {
  runGit(repositoryRoot, "add", "--all");
  runGit(repositoryRoot, "commit", "-m", message);
  return runGit(repositoryRoot, "rev-parse", "HEAD").stdout.trim();
}

function assertOnlyPrimaryWorktreeRemains(repositoryRoot) {
  const worktreeList = runGit(
    repositoryRoot,
    "worktree",
    "list",
    "--porcelain",
  ).stdout;
  const worktrees = worktreeList
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "));

  assert.equal(
    worktrees.length,
    1,
    `temporary worktree was not cleaned up:\n${worktreeList}`,
  );
  assert.equal(
    path.resolve(worktrees[0].slice("worktree ".length)),
    path.resolve(repositoryRoot),
  );
}

function removeIntegrationRepository(repositoryRoot) {
  const worktreeList = runGit(
    repositoryRoot,
    "worktree",
    "list",
    "--porcelain",
  ).stdout;
  const registeredPaths = worktreeList
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));

  for (const registeredPath of registeredPaths) {
    if (registeredPath !== path.resolve(repositoryRoot)) {
      run(
        "git",
        [
          "-C",
          repositoryRoot,
          "worktree",
          "remove",
          "--force",
          "--force",
          registeredPath,
        ],
        repositoryRoot,
        { allowFailure: true },
      );
    }
  }

  const temporaryRoot = path.resolve(tmpdir());
  const resolvedRepository = path.resolve(repositoryRoot);
  assert.equal(
    resolvedRepository.startsWith(`${temporaryRoot}${path.sep}`),
    true,
    "integration repository cleanup escaped the system temporary directory",
  );
  rmSync(resolvedRepository, { recursive: true, force: true });
}

test("unchanged diagnostics remain baseline even when their line moves", () => {
  const baseline = report("/baseline", "src/example.jsx", [
    diagnostic({ message: "Existing problem", line: 4 }),
  ]);
  const head = report("/head", "src/example.jsx", [
    diagnostic({ message: "Existing problem", line: 40 }),
  ]);

  const comparison = compareLintReports(baseline, head, {
    baselineRoot: "/baseline",
    headRoot: "/head",
  });

  assert.equal(comparison.newDiagnostics.length, 0);
  assert.equal(comparison.resolvedCount, 0);
});

test("new diagnostics fail the comparison without hiding the baseline", () => {
  const baseline = report("/baseline", "src/example.jsx", [
    diagnostic({ message: "Existing problem" }),
  ]);
  const head = report("/head", "src/example.jsx", [
    diagnostic({ message: "Existing problem" }),
    diagnostic({
      ruleId: "example/new-rule",
      severity: 1,
      message: "New warning",
      line: 8,
    }),
  ]);

  const comparison = compareLintReports(baseline, head, {
    baselineRoot: "/baseline",
    headRoot: "/head",
  });

  assert.deepEqual(
    comparison.newDiagnostics.map(({ ruleId, severity, message }) => ({
      ruleId,
      severity,
      message,
    })),
    [
      {
        ruleId: "example/new-rule",
        severity: 1,
        message: "New warning",
      },
    ],
  );
  assert.equal(comparison.resolvedCount, 0);
});

test("duplicate diagnostics are compared as a multiset", () => {
  const repeated = diagnostic({ message: "Repeated problem" });
  const baseline = report("/baseline", "src/example.jsx", [repeated]);
  const head = report("/head", "src/example.jsx", [repeated, repeated]);

  const comparison = compareLintReports(baseline, head, {
    baselineRoot: "/baseline",
    headRoot: "/head",
  });

  assert.equal(comparison.newDiagnostics.length, 1);
  assert.equal(comparison.newDiagnostics[0].message, "Repeated problem");
});

test("resolved diagnostics are reported without failing the comparison", () => {
  const baseline = report("/baseline", "src/example.jsx", [
    diagnostic({ message: "Resolved problem" }),
  ]);
  const head = report("/head", "src/example.jsx", []);

  const comparison = compareLintReports(baseline, head, {
    baselineRoot: "/baseline",
    headRoot: "/head",
  });

  assert.equal(comparison.newDiagnostics.length, 0);
  assert.equal(comparison.resolvedCount, 1);
});

test("CLI installs and uses distinct locked baseline and head ESLint toolchains", () => {
  const repositoryRoot = initializeRepository("firstknock-lint-toolchains-");

  try {
    writeLocalEslintFixture(repositoryRoot, {
      version: "1.0.0",
      messages: [
        diagnostic({
          ruleId: "baseline/rule",
          message: "Only the baseline toolchain reports this",
        }),
      ],
      includeLockfile: true,
    });
    const baselineSha = commitAll(repositoryRoot, "baseline toolchain");

    rmSync(path.join(repositoryRoot, "package-lock.json"), { force: true });
    rmSync(path.join(repositoryRoot, "node_modules"), {
      recursive: true,
      force: true,
    });
    writeLocalEslintFixture(repositoryRoot, {
      version: "2.0.0",
      messages: [],
      includeLockfile: true,
    });
    commitAll(repositoryRoot, "head toolchain");
    runNpm(
      repositoryRoot,
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    );

    const result = run(
      process.execPath,
      [lintDiffScript, "--base", baselineSha, "--head", "HEAD"],
      repositoryRoot,
      { allowFailure: true },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /baseline: 1 error\(s\), 0 warning\(s\)/);
    assert.match(result.stdout, /head:\s+0 error\(s\), 0 warning\(s\)/);
    assert.match(result.stdout, /resolved diagnostics: 1/);
    assertOnlyPrimaryWorktreeRemains(repositoryRoot);
  } finally {
    removeIntegrationRepository(repositoryRoot);
  }
});

test("CLI fails closed and removes its worktree when baseline npm ci fails", () => {
  const repositoryRoot = initializeRepository("firstknock-lint-cleanup-");

  try {
    writeLocalEslintFixture(repositoryRoot, {
      version: "1.0.0",
      messages: [],
      includeLockfile: false,
    });
    const baselineSha = commitAll(repositoryRoot, "baseline without lockfile");

    writeLocalEslintFixture(repositoryRoot, {
      version: "2.0.0",
      messages: [],
      includeLockfile: true,
    });
    commitAll(repositoryRoot, "head with lockfile");
    runNpm(
      repositoryRoot,
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    );

    const result = run(
      process.execPath,
      [lintDiffScript, "--base", baselineSha, "--head", "HEAD"],
      repositoryRoot,
      { allowFailure: true },
    );

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stderr,
      /Locked baseline dependency installation failed/,
    );
    assertOnlyPrimaryWorktreeRemains(repositoryRoot);
  } finally {
    removeIntegrationRepository(repositoryRoot);
  }
});
