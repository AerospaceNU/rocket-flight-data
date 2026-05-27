# File Input Interface

Each parser module in this directory must export an object with this shape:

```js
module.exports = {
  id: "unique-id",
  priority: 10, // higher runs first
  supports(fileInput) {
    return true; // fileInput contains name/path/ext
  },
  parseSummary(fileInput, api) {
    return { kind, format, metadata, rows, columns };
  },
  parseViewer(fileInput, api) {
    // optional; defaults to parseSummary
    return { kind, format, metadata, rows, columns };
  },
};
```

The runtime loads all `*.interface.js` files from this directory.
