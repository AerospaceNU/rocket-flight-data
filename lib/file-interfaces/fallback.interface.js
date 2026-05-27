module.exports = {
  id: "fallback",
  priority: 0,
  supports() {
    return true;
  },
  parseSummary(fileInput) {
    return {
      kind: "unsupported",
      format: `${fileInput.ext ? fileInput.ext.slice(1) : "unknown"}-unsupported`,
      metadata: {},
      rows: [],
      columns: [],
    };
  },
};
