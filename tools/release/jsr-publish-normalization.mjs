#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { compareText } from "./release-graph.mjs";

const TOOL = "jsr-publish-normalization";
const PROOF = /^(?:sha256-)[0-9a-f]{64}$/u;
const SLOPPY_IMPORT_TARGETS = new Map([
  [".cjs", [".cts"]],
  [".js", [".ts", ".tsx", ".jsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
]);
const SOURCE_LOADERS = new Map([
  [".cjs", "js"],
  [".cts", "ts"],
  [".js", "js"],
  [".jsx", "jsx"],
  [".mjs", "js"],
  [".mts", "ts"],
  [".ts", "ts"],
  [".tsx", "tsx"],
]);

const OLIPHAUNT_SLOPPY_IMPORT_PROOFS = Object.freeze({
  "/src/jsr.ts": Object.freeze({
    raw: Object.freeze({
      checksum: "sha256-9951733bc3dd68542ac51fef522b10121ab782562b650857e102eb42495038a0",
      size: 938,
    }),
    published: Object.freeze({
      checksum: "sha256-5deab23099b38b44af86bcafbcdc8a4fb487444880e23b260e74d1c8b6379774",
      size: 938,
    }),
  }),
  "/src/query.ts": Object.freeze({
    raw: Object.freeze({
      checksum: "sha256-6f79d1dd81f65fe64a1e8857fd6a77d50305293484c172c95f6f5af6f994ca22",
      size: 19095,
    }),
    published: Object.freeze({
      checksum: "sha256-b25ea0cf76c117e0f681a4c4dd2b506c62b4fb0abacaa0319472bd1c87186191",
      size: 19095,
    }),
  }),
});

// Deno's JSR publisher rewrites Node-style `.js` specifiers when its sloppy
// import resolver selects an included TypeScript source. These records are not
// a general byte-equivalence escape hatch: each one is bound to the complete
// immutable lock/source/carrier/version identity and exact raw/published file
// proofs. Every file outside the exact record remains raw-byte strict.
const JSR_PUBLISH_NORMALIZATIONS = Object.freeze([
  Object.freeze({
    carrierId: "jsr:@oliphaunt/ts",
    lockDigest: "5ee675ab3066cca7df21dd425a5c80fd6c9b9c4b276757fc1aa84e2020761266",
    source: Object.freeze({
      commit: "9c398f4e5c05f494f9b752a8634e74e0bc11dd19",
      tree: "396cf3b10adb1a5b625e66c5ebacf8c3d364b543",
    }),
    version: "0.1.0",
    files: OLIPHAUNT_SLOPPY_IMPORT_PROOFS,
  }),
  Object.freeze({
    carrierId: "jsr:@oliphaunt/ts",
    lockDigest: "d1a9f799c1fd40582e7a824ccc6ec6650cba55b8a95592d3d2f626ba33cd6188",
    source: Object.freeze({
      commit: "ae3d29ba16245e9345a8d337cd17c53f9bf2e853",
      tree: "673e8f249d2f51d10997f0036a7e471bf35a388e",
    }),
    version: "0.1.1",
    files: OLIPHAUNT_SLOPPY_IMPORT_PROOFS,
  }),
]);

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fileProof(value, context) {
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || stableJson(Object.keys(value).sort(compareText)) !== stableJson(["checksum", "size"])
    || !PROOF.test(value.checksum)
    || !Number.isSafeInteger(value.size)
    || value.size < 0
  ) {
    throw error(`${context} must be an exact SHA-256 checksum and non-negative byte size`);
  }
  return { checksum: value.checksum, size: value.size };
}

function safePublishPath(value, carrier) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || path.posix.isAbsolute(value)
  ) {
    throw error(`${carrier.id} has unsafe JSR publish.include path ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || /[*?\[\]{}]/u.test(value)) {
    throw error(
      `${carrier.id} JSR byte verification requires explicit, repository-relative `
        + `publish.include files; got ${JSON.stringify(value)}`,
    );
  }
  return normalized.replace(/^\.\//u, "");
}

function rawFileProof(file, carrier, relative) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw error(`${carrier.id} JSR publish.include file is unavailable: ${relative}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw error(`${carrier.id} JSR publish.include entry is not a regular file: ${relative}`);
  }
  return {
    checksum: `sha256-${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
    size: stat.size,
  };
}

function matchingNormalization(lock, carrier) {
  const matches = JSR_PUBLISH_NORMALIZATIONS.filter((entry) =>
    entry.lockDigest === lock?.lockDigest
    && entry.source.commit === lock?.source?.commit
    && entry.source.tree === lock?.source?.tree
    && entry.carrierId === carrier?.id
    && entry.version === carrier?.version);
  if (matches.length > 1) {
    throw error(`${carrier.id} has duplicate exact publish normalization records`);
  }
  return matches[0] ?? null;
}

function sloppyImportCandidates(specifier) {
  const extension = path.posix.extname(specifier);
  const replacements = SLOPPY_IMPORT_TARGETS.get(extension) ?? [];
  const base = specifier.slice(0, specifier.length - extension.length);
  return replacements.map((replacement) => `${base}${replacement}`);
}

function rewriteProneFiles(directory, rawFiles, carrier) {
  const included = new Set(Object.keys(rawFiles));
  const prone = [];
  for (const name of [...included].sort(compareText)) {
    const loader = SOURCE_LOADERS.get(path.posix.extname(name));
    if (loader === undefined) continue;
    const relative = name.slice(1);
    const text = readFileSync(path.join(directory, ...relative.split("/")), "utf8");
    let imports;
    try {
      imports = new Bun.Transpiler({ loader }).scanImports(text);
    } catch (cause) {
      throw error(
        `${carrier.id} cannot parse included JSR source ${relative}: `
          + (cause instanceof Error ? cause.message : String(cause)),
      );
    }
    const resolvesToIncludedSource = imports.some(({ path: specifier }) => {
      if (!specifier.startsWith(".")) return false;
      const base = path.posix.dirname(relative);
      const literal = path.posix.normalize(path.posix.join(base, specifier));
      if (literal !== ".." && !literal.startsWith("../") && included.has(`/${literal}`)) {
        return false;
      }
      return sloppyImportCandidates(specifier).some((candidate) => {
        const resolved = path.posix.normalize(path.posix.join(base, candidate));
        return resolved !== ".." && !resolved.startsWith("../") && included.has(`/${resolved}`);
      });
    });
    if (resolvesToIncludedSource) prone.push(name);
  }
  return prone;
}

function admittedNormalization(lock, carrier, rawFiles, proneFiles) {
  const normalization = matchingNormalization(lock, carrier);
  if (proneFiles.length === 0) {
    if (normalization !== null && Object.keys(normalization.files).length > 0) {
      throw error(`${carrier.id} exact publish normalization record no longer describes rewrite-prone source`);
    }
    return null;
  }
  if (normalization === null) {
    throw error(
      `${carrier.id}@${carrier.version} contains Deno/JSR rewrite-prone local JavaScript specifiers `
        + "without an exact pre-recorded publish normalization for this lock/source/carrier/version",
    );
  }
  const recordedFiles = Object.keys(normalization.files).sort(compareText);
  if (stableJson(recordedFiles) !== stableJson(proneFiles)) {
    throw error(
      `${carrier.id} exact publish normalization must cover precisely the rewrite-prone files: `
        + `expected=${JSON.stringify(proneFiles)}, recorded=${JSON.stringify(recordedFiles)}`,
    );
  }
  for (const name of recordedFiles) {
    const record = normalization.files[name];
    const expectedRaw = fileProof(record?.raw, `${carrier.id} normalization ${name} raw proof`);
    fileProof(record?.published, `${carrier.id} normalization ${name} published proof`);
    if (stableJson(rawFiles[name]) !== stableJson(expectedRaw)) {
      throw error(
        `${carrier.id} frozen JSR source no longer matches its exact publish-time normalization record for ${name}`,
      );
    }
  }
  return normalization;
}

export function jsrPublishedFileProof(lock, carrier, name, raw) {
  const normalization = matchingNormalization(lock, carrier);
  const expected = normalization?.files[name];
  if (expected === undefined) return raw;
  const expectedRaw = fileProof(expected.raw, `${carrier.id} normalization ${name} raw proof`);
  if (stableJson(raw) !== stableJson(expectedRaw)) {
    throw error(
      `${carrier.id} frozen JSR source no longer matches its exact publish-time normalization record for ${name}`,
    );
  }
  return fileProof(expected.published, `${carrier.id} normalization ${name} published proof`);
}

export function expectedJsrPublishedManifest({ carrier, directory, lock }) {
  let config;
  try {
    config = JSON.parse(readFileSync(path.join(directory, "jsr.json"), "utf8"));
  } catch (cause) {
    throw error(`${carrier.id} cannot read strict jsr.json: ${cause.message}`);
  }
  const include = config?.publish?.include;
  if (!Array.isArray(include) || include.length === 0) {
    throw error(`${carrier.id} jsr.json must declare a nonempty explicit publish.include list`);
  }
  if (config.name !== carrier.name || config.version !== carrier.version) {
    throw error(`${carrier.id} jsr.json identity does not match the frozen carrier`);
  }
  const rawFiles = {};
  for (const value of include) {
    const relative = safePublishPath(value, carrier);
    const name = `/${relative}`;
    if (Object.hasOwn(rawFiles, name)) {
      throw error(`${carrier.id} jsr.json publish.include repeats ${relative}`);
    }
    const file = path.join(directory, ...relative.split("/"));
    rawFiles[name] = rawFileProof(file, carrier, relative);
  }
  const canonicalRawFiles = Object.fromEntries(
    Object.entries(rawFiles).sort(([left], [right]) => compareText(left, right)),
  );
  const proneFiles = rewriteProneFiles(directory, canonicalRawFiles, carrier);
  const normalization = admittedNormalization(lock, carrier, canonicalRawFiles, proneFiles);
  return Object.fromEntries(Object.entries(canonicalRawFiles).map(([name, raw]) => [
    name,
    normalization?.files[name] === undefined
      ? raw
      : jsrPublishedFileProof(lock, carrier, name, raw),
  ]));
}
