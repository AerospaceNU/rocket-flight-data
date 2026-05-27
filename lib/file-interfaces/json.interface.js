module.exports = {
  id: "metadata-json",
  priority: 100,
  supports(fileInput) {
    return fileInput.ext === ".json";
  },
  parseSummary(fileInput, api) {
    return api.parseJsonMetadata(fileInput.fullPath);
  },
};
