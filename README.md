# rocket-flight-data

Logs from rocket flight data.

## Flight Viewer App (Electron)

The app runs locally and provides:

- flight list + filters
- altimeter-level selection (instead of per-file selection)
- tabbed views for summary, 2D plot, 3D plot, raw data, metadata
- event display using only explicitly reported events
- persisted user overrides for flight/altimeter/file metadata
- schema-driven flight parameter editing

## Setup

```bash
npm install
```

## Data Reorganization (one-time for legacy folders)

If flight folders still contain all files directly in the flight directory, run:

```bash
npm run reorganize-data
```

This moves files into per-altimeter subfolders within each flight directory.

## Indexing

Indexing can be run from the GUI (`Run Index` button) or CLI:

```bash
npm run index-data
```

The indexer scans `data/` recursively, writes `.flight-overview.json` into each flight folder, and skips unchanged flights on subsequent runs.

## Launch

```bash
npm start
```

Or index + launch:

```bash
npm run start:indexed
```

## Data Layout

```text
data/
  <YYYY-MM-DD> <Rocket Name>/
    <altimeter-group>/
      <log files>
    .flight-overview.json
    .flight-user-overrides.json   (optional, user-authored)
```

Each subdirectory of `data/` corresponds to one launch day and rocket.

## Override Persistence

Summary edit mode writes to `.flight-user-overrides.json`.
Those overrides are merged back during re-indexing and are designed to remain stable across parser/code updates.

## Extensible File Type Interfaces

File parsing is interface-driven from `lib/file-interfaces/`.

- One `*.interface.js` file per file type
- Runtime dynamically loads all interfaces from that directory
- Add new file support by dropping in another interface module

See [FILE_INPUT_INTERFACE.md](C:/Users/patri/Documents/Software/rocket-flight-data/lib/file-interfaces/FILE_INPUT_INTERFACE.md).

## Flight Attribute Schema

The standard editable flight parameter list is defined in `config/flight-attributes.json`.
The summary editor renders this schema as a scrollable form (typed fields), and values persist in `.flight-user-overrides.json`.

## SillyGoose Naming Convention

```text
<YYYY-MM-DD> V<n> <Rocket Name> <descriptors...>.txt
```

Common descriptors:

- `primary`
- `backup`
- `ridealong`
- `board1` / `board2` / ...
- `pre reboot` / `post reboot`
- `doctored`
