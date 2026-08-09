#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLedgerRequirement,
  collectLedgerRows,
} from "../../.github/scripts/registry-bootstrap-ledger-state.mjs";

test("requires a ledger only for pre-tag current-version registry publications", () => {
  assert.deepEqual(classifyLedgerRequirement([
    { product: "new", ecosystem: "npm", published: 0, tagState: "missing" },
    { product: "retry", ecosystem: "cargo", published: 1, tagState: "exact" },
  ]), { needsLedger: false, requiring: [] });

  const bootstrap = classifyLedgerRequirement([
    { product: "bootstrap", ecosystem: "npm", published: 2, tagState: "missing" },
  ]);
  assert.equal(bootstrap.needsLedger, true);
  assert.deepEqual(bootstrap.requiring, [{ product: "bootstrap", ecosystem: "npm", published: 2 }]);

  assert.throws(
    () => classifyLedgerRequirement([{ product: "conflict", ecosystem: "npm", published: 1, tagState: "wrong" }]),
    /another commit/u,
  );
});

test("resolves product tags before registry reads and records exact-tag skips explicitly", () => {
  const lock = {
    products: [
      { id: "exact", version: "1.0.0" },
      { id: "missing", version: "2.0.0" },
    ],
  };
  const queries = [];
  const rows = collectLedgerRows({
    lock,
    lockFile: "publication-lock.json",
    products: ["exact", "missing"],
    headCommit: "a".repeat(40),
  }, {
    carriersFor: (_lock, { product, ecosystem }) =>
      ecosystem === "cargo" || product === "exact" ? [{ id: `${product}:${ecosystem}` }] : [],
    queryPublication: (_lock, product, ecosystem) => {
      queries.push(`${product}:${ecosystem}`);
      return { published: [{ id: "published" }], missing: [] };
    },
    resolveTagState: (product) => product === "exact" ? "exact" : "missing",
  });

  assert.deepEqual(queries, ["missing:cargo"]);
  assert.deepEqual(rows, [
    {
      product: "exact",
      ecosystem: "cargo",
      published: null,
      missing: null,
      queryState: "skipped-exact-tag",
      tagState: "exact",
    },
    {
      product: "exact",
      ecosystem: "npm",
      published: null,
      missing: null,
      queryState: "skipped-exact-tag",
      tagState: "exact",
    },
    {
      product: "missing",
      ecosystem: "cargo",
      published: 1,
      missing: 0,
      queryState: "queried",
      tagState: "missing",
    },
  ]);
  assert.deepEqual(classifyLedgerRequirement(rows), {
    needsLedger: true,
    requiring: [{ product: "missing", ecosystem: "cargo", published: 1 }],
  });
});

test("rejects a wrong product tag before any registry query", () => {
  let queries = 0;
  assert.throws(
    () => collectLedgerRows({
      lock: { products: [{ id: "conflict", version: "1.0.0" }] },
      lockFile: "publication-lock.json",
      products: ["conflict"],
      headCommit: "a".repeat(40),
    }, {
      carriersFor: () => [{ id: "must-not-be-read" }],
      queryPublication: () => {
        queries += 1;
        return { published: [], missing: [] };
      },
      resolveTagState: () => "wrong",
    }),
    /another commit/u,
  );
  assert.equal(queries, 0);
});
