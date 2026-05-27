module.exports = {
  id: "binary",
  priority: 80,
  supports(fileInput) {
    return fileInput.ext === ".eeprom" || fileInput.ext === ".bin";
  },
  parseSummary(fileInput) {
    return {
      kind: "unsupported",
      format: `${fileInput.ext.slice(1)}-binary`,
      metadata: {},
      rows: [],
      columns: [],
    };
  },
};
