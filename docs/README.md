# Documentation

Start with **[00 Overview](00-overview.md)**. The chapters follow the data through the system:

1. [01 Data sources](01-data-sources.md): ISZZ measurements, Open-Meteo weather, CAMS background
2. [02 Geometry](02-geometry.md): ZG3D 2022 (LiDAR-updated 3D city model), terrain, OpenStreetMap
3. [03 Wind (LBM)](03-flow-lbm.md): GPU Lattice-Boltzmann wind tunnel
4. [04 Dispersion](04-dispersion.md): GPU steady advection–diffusion, verification
5. [05 Emissions](05-emissions.md): traffic, fleet, heating, scenario measures
6. [06 Chemistry](06-chemistry.md): NO–NO₂–O₃, background, limit values, index
7. [07 Calibration](07-calibration.md): how well the model matches the station, on held-out data
8. [08 User guide](08-user-guide.md): every control in the page
9. [09 Limitations](09-limitations.md)
10. [10 Runbook](10-runbook.md): commands for data, build, tests, LUT, calibration, deploy
11. [11 Process](11-process.md): how this repository was researched and built, step by step
12. [12 Rendering](12-rendering.md): the 3D scene and the scenarios

Reference material:

- [architecture.md](architecture.md): the binding interface contract (files, schemas, function signatures)
- [research/](research/): the five research reports (LiDAR/3D, ISZZ API, site context, physics, critic)
- [glossary.md](glossary.md) · [references.md](references.md)

Conventions used in every chapter:

- **Structure.** Each chapter opens with its purpose and ends with how to re-run or check what it describes; the
  technical chapters (01–08, 12) also list their inputs and outputs. [10 Runbook](10-runbook.md) collects all the
  commands.
- **Section references.** "docs/07 §9" or "chapter 07 §9" is section 9 of chapter 07. "architecture §6.1" is
  [architecture.md](architecture.md). "physics §6.2", "critic §4.3", "iszz-api §4", "site-context §3" and
  "lidar-3d §3.2" are the research reports in [research/](research/); a number like `iszz-api §4.4` there can be
  item 4 of the numbered list in section 4. Chapters 00, 02, 09, 10 and 11 prefix their section numbers with the
  chapter number (`§2.3`, `§10.4`); the others number from 1.
- **Contract and deviations.** In [architecture.md](architecture.md), the "As implemented" notes are authoritative
  where they differ from the original contract text.
- **Time.** Every time is UTC and hour-ending, as in ISZZ; the page shows local time (Europe/Zagreb)
  ([glossary](glossary.md)).
- **Numbers that change.** The calibration results are generated into [07 Calibration](07-calibration.md) §9 by
  `tools/calibrate.py`; quote them from there. Numbers measured on an earlier data version are marked with that
  version (for example "env.json of 2026-09-27", "on the 10 m grid (first calibration)").
