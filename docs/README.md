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
