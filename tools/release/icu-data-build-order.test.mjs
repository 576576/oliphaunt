#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT } from "./release-graph.mjs";

const PRODUCERS = [
  {
    dataNameConfig: '"$target_build_dir/config/Makefile.inc"',
    parallelBuild: 'make -j"$jobs" PKGDATA_OPTS="$icu_pkgdata_opts"',
    parallelData: 'make -j"$jobs" -C data packagedata PKGDATA_OPTS="$icu_pkgdata_opts"',
    script: "src/runtimes/liboliphaunt/native/bin/icu.sh",
  },
  {
    dataNameConfig: '"$ICU_BUILD_DIR/config/Makefile.inc"',
    parallelBuild: 'make -j"$JOBS" PKGDATA_OPTS="$icu_pkgdata_opts"',
    parallelData: 'make -j"$JOBS" -C data packagedata PKGDATA_OPTS="$icu_pkgdata_opts"',
    script: "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh",
  },
];

function executableLineIndex(source, command, fromIndex = 0) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^[ \\t]*${escaped}[ \\t]*$`, "mu").exec(source.slice(fromIndex));
  return match === null ? -1 : fromIndex + match.index;
}

for (const { dataNameConfig, parallelBuild, parallelData, script } of PRODUCERS) {
  test(`${script} completes ICU converter aliases before parallel data generation`, () => {
    const source = readFileSync(path.join(ROOT, script), "utf8");
    const configIndex = source.indexOf(dataNameConfig);
    const aliasIndex = executableLineIndex(
      source,
      'make -j1 -C data "out/build/$icu_data_name/cnvalias.icu" PKGDATA_OPTS="$icu_pkgdata_opts"',
      configIndex,
    );
    const validationIndex = source.lastIndexOf('^icudt[0-9]+[a-z]+$', aliasIndex);
    const parallelIndex = executableLineIndex(source, parallelBuild, configIndex);
    const packagedataIndex = executableLineIndex(source, parallelData, parallelIndex + parallelBuild.length);

    assert.notEqual(configIndex, -1, `${script} must derive ICU's configured data name`);
    assert.notEqual(validationIndex, -1, `${script} must reject a malformed ICU data name`);
    assert.notEqual(aliasIndex, -1, `${script} must build cnvalias.icu serially`);
    assert.notEqual(parallelIndex, -1, `${script} must retain parallel target compilation`);
    assert.notEqual(packagedataIndex, -1, `${script} must retain the packagedata phase`);
    assert.ok(
      configIndex < validationIndex && validationIndex < aliasIndex && aliasIndex < parallelIndex,
      `${script} must validate and complete cnvalias.icu before parallel data generation`,
    );
  });
}
