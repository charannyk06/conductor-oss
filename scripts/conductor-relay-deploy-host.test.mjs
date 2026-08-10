import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "conductor-relay-deploy-host.sh");
const expectedOwner = "999:999";
const readinessBytes = "relay-readiness";
const stateContent = '{"claims":[]}\n';
const validProbeName = "state.0123456789abcdef0123456789abcdef.readiness";
const secondValidProbeName = "state.abcdef0123456789abcdef0123456789.readiness";

function metaPathFor(metaDir, targetPath) {
  return join(metaDir, targetPath.replaceAll("/", "__"));
}

function writeMetadata(metaDir, targetPath, metadata) {
  const lines = [
    `mode=${metadata.mode}`,
    `owner=${metadata.owner}`,
    `links=${metadata.links}`,
    `size=${metadata.size}`,
  ];
  writeFileSync(metaPathFor(metaDir, targetPath), `${lines.join("\n")}\n`, "utf8");
}

function writeFileWithMetadata(metaDir, targetPath, content, metadata = {}) {
  writeFileSync(targetPath, content);
  if (metadata.mode !== undefined) {
    chmodSync(targetPath, Number.parseInt(metadata.mode, 8));
  }
  writeMetadata(metaDir, targetPath, {
    mode: metadata.mode ?? "600",
    owner: metadata.owner ?? expectedOwner,
    links: metadata.links ?? "1",
    size: metadata.size ?? String(Buffer.byteLength(content)),
  });
}

function writeDirectoryMetadata(metaDir, targetPath, metadata = {}) {
  writeMetadata(metaDir, targetPath, {
    mode: metadata.mode ?? "700",
    owner: metadata.owner ?? expectedOwner,
    links: metadata.links ?? "1",
    size: metadata.size ?? "0",
  });
}

function installFakeCoreutils(binDir) {
  const findmntPath = join(binDir, "findmnt");
  writeFileSync(
    findmntPath,
    "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'tmpfs\\n'\n",
    "utf8",
  );
  chmodSync(findmntPath, 0o755);

  const dfPath = join(binDir, "df");
  writeFileSync(
    dfPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf 'Filesystem 1B-blocks Used Available Use%% Mounted on\\n'",
      "printf 'tmpfs 200000000 1 199999999 1%% %s\\n' \"${@: -1}\"",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(dfPath, 0o755);

  const mktempPath = join(binDir, "mktemp");
  writeFileSync(
    mktempPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "root=${TEST_MKTEMP_ROOT:?}",
      "mkdir -p -- \"$root\"",
      "while :; do",
      "  candidate=\"$root/conductor-relay-state.$RANDOM$RANDOM\"",
      "  if mkdir -- \"$candidate\" 2>/dev/null; then",
      "    printf '%s\\n' \"$candidate\"",
      "    exit 0",
      "  fi",
      "done",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(mktempPath, 0o755);

  const statPath = join(binDir, "stat");
  writeFileSync(
    statPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"$#\" -ne 3 ] || [ \"$1\" != \"-c\" ]; then",
      "  echo 'unsupported stat invocation' >&2",
      "  exit 2",
      "fi",
      "format=$2",
      "target=$3",
      "meta_key=${target//\\//__}",
      "meta_file=\"${TEST_META_DIR:?}/$meta_key\"",
      "if [ ! -f \"$meta_file\" ]; then",
      "  echo \"missing metadata for $target\" >&2",
      "  exit 2",
      "fi",
      ". \"$meta_file\"",
      "case \"$format\" in",
      "  %a) printf '%s\\n' \"$mode\" ;;",
      "  %u:%g) printf '%s\\n' \"$owner\" ;;",
      "  %h) printf '%s\\n' \"$links\" ;;",
      "  %s) printf '%s\\n' \"$size\" ;;",
      "  *) echo \"unsupported stat format: $format\" >&2; exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(statPath, 0o755);
}

function runBackupScenario(prepareScenario, { sourceName = "state.json" } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "conductor-relay-deploy-host-test-"));
  const stateDir = join(rootDir, "state");
  const shmDir = join(rootDir, "shm");
  const binDir = join(rootDir, "bin");
  const metaDir = join(rootDir, "meta");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(shmDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });
  installFakeCoreutils(binDir);
  writeDirectoryMetadata(metaDir, stateDir);

  const statePath = join(stateDir, sourceName);
  writeFileWithMetadata(metaDir, statePath, stateContent);

  prepareScenario({
    metaDir,
    rootDir,
    stateDir,
    statePath,
  });

  const harness = [
    "set -euo pipefail",
    `TEST_STATE_DIR=${JSON.stringify(stateDir)}`,
    `TEST_BIN_DIR=${JSON.stringify(binDir)}`,
    `TEST_MKTEMP_ROOT=${JSON.stringify(shmDir)}`,
    `TEST_META_DIR=${JSON.stringify(metaDir)}`,
    "export TEST_STATE_DIR TEST_BIN_DIR TEST_MKTEMP_ROOT TEST_META_DIR",
    'PATH="$TEST_BIN_DIR:$PATH"',
    "export PATH",
    `CONDUCTOR_RELAY_DEPLOY_HOST_SOURCE_ONLY=1 source ${JSON.stringify(scriptPath)}`,
    `state_backup_tmpfs_root=${JSON.stringify(shmDir)}`,
    'current_image_id="fake-image"',
    `candidate_state_owner=${JSON.stringify(expectedOwner)}`,
    `state_filename_current=${JSON.stringify(sourceName)}`,
    "run_docker() {",
    '  if [ "$1" != "run" ]; then',
    '    echo "unsupported run_docker invocation: $*" >&2',
    "    return 97",
    "  fi",
    "  shift",
    '  local inner_script=""',
    '  while [ "$#" -gt 0 ]; do',
    '    if [ "$1" = "-ec" ]; then',
    '      inner_script="$2"',
    "      shift 2",
    "      break",
    "    fi",
    "    shift",
    "  done",
    '  if [ -z "$inner_script" ] || [ "$#" -lt 1 ]; then',
    '    echo "malformed run_docker invocation" >&2',
    "    return 98",
    "  fi",
    "  shift",
    '  local translated_script="${inner_script//\\/state\\//__TEST_STATE_DIR_SLASH__}"',
    '  translated_script="${translated_script//\\/backup\\//__TEST_BACKUP_DIR_SLASH__}"',
    '  translated_script="${translated_script//\\/state/__TEST_STATE_DIR__}"',
    '  translated_script="${translated_script//\\/backup/__TEST_BACKUP_DIR__}"',
    '  translated_script="${translated_script//__TEST_STATE_DIR_SLASH__/$TEST_STATE_DIR/}"',
    '  translated_script="${translated_script//__TEST_BACKUP_DIR_SLASH__/$state_backup_dir/}"',
    '  translated_script="${translated_script//__TEST_STATE_DIR__/$TEST_STATE_DIR}"',
    '  translated_script="${translated_script//__TEST_BACKUP_DIR__/$state_backup_dir}"',
    '  PATH="$TEST_BIN_DIR:$PATH" sh -ec "$translated_script" sh "$@"',
    "}",
    "if backup_relay_state; then",
    "  printf 'backup_dir=%s\\n' \"$state_backup_dir\"",
    "  printf 'backup_ready=%s\\n' \"$state_backup_ready\"",
    "  printf 'backup_existed=%s\\n' \"$state_backup_existed\"",
    "  printf 'backup_owner=%s\\n' \"$state_backup_owner\"",
    "  printf 'backup_size=%s\\n' \"$state_backup_size\"",
    "else",
    "  exit $?",
    "fi",
    "",
  ].join("\n");

  const result = spawnSync("bash", ["-s"], {
    cwd: rootDir,
    env: { ...process.env },
    input: harness,
    encoding: "utf8",
  });

  return {
    ...result,
    rootDir,
    stateDir,
  };
}

function parseKeyValueOutput(stdout) {
  const output = {};
  for (const line of stdout.trim().split("\n")) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    output[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return output;
}

function assertBackupFailed(result) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not create a secure relay state rollback snapshot/);
}

test("backup_relay_state removes validated stale readiness probes and snapshots state", () => {
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, validProbeName), readinessBytes);
    writeFileWithMetadata(metaDir, join(stateDir, secondValidProbeName), readinessBytes);
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    const output = parseKeyValueOutput(result.stdout);
    assert.equal(output.backup_ready, "1");
    assert.equal(output.backup_existed, "1");
    assert.equal(output.backup_owner, expectedOwner);
    assert.equal(output.backup_size, String(Buffer.byteLength(stateContent)));
    assert.equal(existsSync(join(result.stateDir, validProbeName)), false);
    assert.equal(existsSync(join(result.stateDir, secondValidProbeName)), false);
    assert.equal(readFileSync(join(output.backup_dir, "state.json"), "utf8"), stateContent);
    assert.deepEqual(readdirSync(result.stateDir), ["state.json"]);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state removes validated legacy relay-state readiness probes", () => {
  const sourceName = "relay-state.json";
  const probeName = "relay-state.0123456789abcdef0123456789abcdef.readiness";
  const result = runBackupScenario(
    ({ metaDir, stateDir }) => {
      writeFileWithMetadata(metaDir, join(stateDir, probeName), readinessBytes);
    },
    { sourceName },
  );

  try {
    assert.equal(result.status, 0, result.stderr);
    const output = parseKeyValueOutput(result.stdout);
    assert.equal(output.backup_ready, "1");
    assert.equal(output.backup_existed, "1");
    assert.equal(existsSync(join(result.stateDir, probeName)), false);
    assert.equal(readFileSync(join(output.backup_dir, "state.json"), "utf8"), stateContent);
    assert.deepEqual(readdirSync(result.stateDir), [sourceName]);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state rejects lookalike readiness filenames", () => {
  const probeName = "state.0123456789abcdef0123456789abcdef.readiness.tmp";
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, probeName), readinessBytes);
  });

  try {
    assertBackupFailed(result);
    assert.equal(existsSync(join(result.stateDir, probeName)), true);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state rejects readiness probe symlinks", () => {
  const result = runBackupScenario(({ stateDir, statePath }) => {
    symlinkSync(statePath, join(stateDir, validProbeName));
  });

  try {
    assertBackupFailed(result);
    assert.equal(lstatSync(join(result.stateDir, validProbeName)).isSymbolicLink(), true);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state rejects readiness probes with the wrong mode", () => {
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, validProbeName), readinessBytes, { mode: "644" });
  });

  try {
    assertBackupFailed(result);
    assert.equal(existsSync(join(result.stateDir, validProbeName)), true);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state rejects readiness probes with the wrong owner", () => {
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, validProbeName), readinessBytes, {
      owner: "1000:1000",
    });
  });

  try {
    assertBackupFailed(result);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state rejects readiness probes with the wrong link count", () => {
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, validProbeName), readinessBytes, { links: "2" });
  });

  try {
    assertBackupFailed(result);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state rejects readiness probes with the wrong size", () => {
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, validProbeName), readinessBytes, { size: "14" });
  });

  try {
    assertBackupFailed(result);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state rejects readiness probes with the wrong content", () => {
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, validProbeName), "relay-readinesx");
  });

  try {
    assertBackupFailed(result);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state rejects unrelated extra files", () => {
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, "unrelated.txt"), "not allowed");
  });

  try {
    assertBackupFailed(result);
    assert.equal(existsSync(join(result.stateDir, "unrelated.txt")), true);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});

test("backup_relay_state validates every entry before deleting stale probes", () => {
  const unrelatedName = "zz-unrelated.txt";
  const result = runBackupScenario(({ metaDir, stateDir }) => {
    writeFileWithMetadata(metaDir, join(stateDir, validProbeName), readinessBytes);
    writeFileWithMetadata(metaDir, join(stateDir, unrelatedName), "not allowed");
  });

  try {
    assertBackupFailed(result);
    assert.equal(existsSync(join(result.stateDir, validProbeName)), true);
    assert.equal(existsSync(join(result.stateDir, unrelatedName)), true);
  } finally {
    rmSync(result.rootDir, { recursive: true, force: true });
  }
});
