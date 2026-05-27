#!/usr/bin/env node
const path = require("path");
const { getDataRoot, runIndexer, INDEXER_VERSION } = require("../lib/flight-data");

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const dataRoot = getDataRoot(repoRoot);
  const start = Date.now();
  const result = runIndexer(dataRoot);
  const elapsedMs = Date.now() - start;

  console.log(`Indexer version: ${INDEXER_VERSION}`);
  console.log(`Data root: ${dataRoot}`);
  console.log(`Scanned flights: ${result.scanned}`);
  console.log(`Updated overviews: ${result.updated}`);
  console.log(`Skipped (unchanged): ${result.skipped}`);
  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(2)}s`);
}

main();
