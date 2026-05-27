module.exports = {
  id: "tabular",
  priority: 90,
  supports(fileInput) {
    return fileInput.ext === ".csv" || fileInput.ext === ".txt";
  },
  parseSummary(fileInput, api) {
    return api.parseTabularFile(fileInput.fullPath, fileInput.ext);
  },
};
