# rocket-flight-data

Logs from flight data.

## Layout

```
data/
  <YYYY-MM-DD> <Rocket Name>/
    <log files for this flight day>
```

Each subdirectory of `data/` corresponds to a single launch day on a single rocket. The directory name is the **launch date** (not the offload date) followed by the **rocket name**.

## SillyGoose log file naming

```
<YYYY-MM-DD> V<n> <Rocket Name> <descriptors...>.txt
```

| Part | Meaning |
| --- | --- |
| `YYYY-MM-DD` | Launch date. Matches the parent directory. |
| `V<n>` | SillyGoose board hardware revision (`V1`, `V2`, ...). |
| `<Rocket Name>` | Rocket name. Matches the parent directory. |
| `<descriptors>` | Space-separated tags describing this particular file. See below. |

### Descriptors

Stack any combination, separated by spaces. Order is not significant but the examples below reflect the convention.

| Descriptor | Use when |
| --- | --- |
| `primary` | This board was the rocket's primary recovery computer. |
| `backup` | This board was the backup recovery computer behind a non-SillyGoose primary. |
| `ridealong` | This board was a passive payload; another (non-SillyGoose) computer handled recovery. |
| `board1` / `board2` / ... | More than one SillyGoose was on the same flight — use to disambiguate. |
| `pre reboot` / `post reboot` | The board rebooted mid-flight; the log is in multiple segments. |
| `doctored` | The file has been altered after offload (e.g. trimmed, reorder, hand-edited). The original raw offload is *not* preserved in the repo, so always flag a modified file with this tag. |

### Examples

```
2025-11-15 V1 Crocket backup.txt
2025-11-15 V1 MBTA ridealong board1.txt
2025-11-15 V1 MBTA ridealong board2.txt
2026-02-22 V1 Haybales primary pre reboot.txt
2026-02-22 V1 Haybales primary post reboot.txt
2026-02-22 V2 RocketWorks ridealong doctored.txt
2026-05-16 V2 Gianni L3 ridealong.txt
```

## Non-SillyGoose files

Logs from other altimeters (PerfectFlite Stratologger, AltusMetrum EasyMini, etc.) are kept under their original filenames so the source device is obvious. They live alongside the SillyGoose logs in the same flight-day directory.

```
2026-02-22 Ethical Missile/
  2026-02-22 V1 Ethical Missile backup.txt    ← SillyGoose
  EthicalMissile-EasyMini-primary.csv         ← EasyMini, original name
```