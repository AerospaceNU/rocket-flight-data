#!/usr/bin/env node
const path = require("path");
const { getDataRoot, reorganizeDataRoot } = require("../lib/flight-data");

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const dataRoot = getDataRoot(repoRoot);
  const start = Date.now();
  const result = reorganizeDataRoot(dataRoot);
  const elapsedMs = Date.now() - start;

  console.log(`Data root: ${dataRoot}`);
  console.log(`Flights processed: ${result.flightCount}`);
  console.log(`Files moved: ${result.moved}`);
  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(2)}s`);
}

main();
