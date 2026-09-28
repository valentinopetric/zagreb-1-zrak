# References

This page brings together the sources cited in the chapters and in the research reports. The chapters cite them as
"physics §x" or "critic §x" (the reports in [research/](research/)) or by author and year. Items marked **[V]** were
checked against the saved documents or live endpoints during the research (docs/research/physics.md).

## Data and services

| Source | URL | Used in |
|---|---|---|
| ISZZ, Kvaliteta zraka u Republici Hrvatskoj (MZOZT); measurements by DHMZ | <https://iszz.azo.hr/iskzl/> (export: `/rs/podatak/export/json`) | 01, 07 |
| DHMZ station page, Zagreb 1 | <https://meteo.hr/kvaliteta_zraka.php?section=podaci_kz&post=Zagreb+1> | 01 |
| EEA air quality station metadata (HR0007A, HR0041A) | <https://discomap.eea.europa.eu/map/fme/metadata/PanEuropean_metadata.csv> | 00, critic §1.6 |
| Open-Meteo archive, forecast and air-quality APIs (ECMWF IFS, CAMS Europe) | <https://open-meteo.com/en/docs> | 01, 06, 07 |
| ZG3D 2022, 3D model of the City of Zagreb (FeatureServer `ZG3D_2022_3d_model_GZ`) | <https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/ZG3D_2022_3d_model_GZ/FeatureServer/0> | 02 |
| City of Zagreb open data portal | <https://data.zagreb.hr> | 02 |
| DGU INSPIRE elevation, tile RH_ELEV_107 | <https://geoportal.dgu.hr/services/atom/RH_ELEV_107.tif> | 02 |
| DGU LiDAR data request | <https://geoportal.dgu.hr> (form; `izdavanje.podataka@dgu.hr`) | 02 |
| OpenStreetMap via the Overpass API | <https://overpass-api.de> | 02 |
| Directive (EU) 2024/2881 on ambient air quality (limit values from 2030) | <https://eur-lex.europa.eu/eli/dir/2024/2881/oj> | 06 |
| WHO global air quality guidelines (2021) | <https://www.who.int/publications/i/item/9789240034228> | 06 |
| EEA European Air Quality Index | <https://airindex.eea.europa.eu> | 06 |
| three.js 0.170.0 | <https://threejs.org> | code |
| maksimir-pod-kisom (reference repo, MIT) | <https://github.com/ivanrezic/maksimir-pod-kisom> | 03, 11 |

## Physics, numerics, chemistry and evaluation

Items marked **[V]** were checked against the saved documents in `research/data/physics/refs/` or live endpoints.

- ACEA (2025). *Vehicles on European Roads*. (Croatia: diesel share of the stock > 50 %; 78 % petrol/hybrid new registrations.)
- Berkowicz, R. (2000). OSPM — a parameterised street pollution model. *Environ. Monit. Assess.* 65, 323–331.
- Berkowicz, R., Hertel, O., Larsen, S.E., Sørensen, N.N., Nielsen, M. (1997). *Modelling traffic pollution in streets*. NERI, Roskilde.
- Blackadar, A.K. (1962). The vertical distribution of wind and turbulent exchange in a neutral atmosphere. *J. Geophys. Res.* 67, 3095–3102.
- Businger, J.A., Wyngaard, J.C., Izumi, Y., Bradley, E.F. (1971). Flux-profile relationships in the atmospheric surface layer. *J. Atmos. Sci.* 28, 181–189.
- Chang, J.C., Hanna, S.R. (2004). Air quality model performance evaluation. *Meteorol. Atmos. Phys.* 87, 167–196. **[V]**
- Denby, B.R. et al. (2013). A coupled road dust and surface moisture model to predict non-exhaust road traffic induced particle emissions (NORTRIP). Part 1. *Atmos. Environ.* 77, 283–300.
- Derwent, R.G., Middleton, D.R. (1996). An empirical function for the ratio NO₂:NOx. *Clean Air* 26, 57–60. (Formula **[V]** via Middleton et al. 2007, Environment Agency review.)
- Di Sabatino, S., Kastner-Klein, P., Berkowicz, R., Britter, R.E., Fedorovich, E. (2003). The modelling of turbulence from traffic in urban dispersion models — Part I. *Environ. Fluid Mech.* 3, 129–143.
- Dyer, A.J. (1974). A review of flux-profile relationships. *Boundary-Layer Meteorol.* 7, 363–372.
- EMEP/EEA (2023). *Air pollutant emission inventory guidebook 2023*: 1.A.3.b.i–iv Road transport (update 2025) **[V]**; 1.A.3.b.vi–vii Tyre, brake and road wear **[V]**; 1.A.4 Small combustion **[V]**.
- European Union (2008). Directive 2008/50/EC on ambient air quality, Annex III (sampling-point criteria).
- Ginzburg, I. (2005). Equilibrium-type and link-type lattice Boltzmann models for generic advection and anisotropic-dispersion equation. *Adv. Water Resour.* 28, 1171–1195.
- Golder, D. (1972). Relations among stability parameters in the surface layer. *Boundary-Layer Meteorol.* 3, 47–58.
- Grimmond, C.S.B., Oke, T.R. (1999). Aerodynamic properties of urban areas derived from analysis of surface form. *J. Appl. Meteorol.* 38, 1262–1292.
- Hanna, S., Chang, J. (2012). Acceptance criteria for urban dispersion model evaluation. *Meteorol. Atmos. Phys.* 116, 133–146. **[V]** (abstract criteria)
- Hou, S., Sterling, J., Chen, S., Doolen, G.D. (1996). A lattice Boltzmann subgrid model for high Reynolds number flows. *Fields Inst. Commun.* 6, 151–166.
- Irwin, J.S. (1979). A theoretical variation of the wind profile power-law exponent as a function of surface roughness and stability. *Atmos. Environ.* 13, 191–194.
- Kakosimos, K.E., Hertel, O., Ketzel, M., Berkowicz, R. (2010). Operational Street Pollution Model (OSPM) — a review of performed application and validation studies, and future prospects. *Environ. Chem.* 7, 485–503.
- Ketzel, M., Wåhlin, P., Berkowicz, R., Palmgren, F. (2003). Particle and trace gas emission factors under urban driving conditions in Copenhagen based on street and roof-level observations. *Atmos. Environ.* 37, 2735–2749.
- Ketzel, M. et al. (2007). Estimation and validation of PM2.5/PM10 exhaust and non-exhaust emission factors for practical street pollution modelling. *Atmos. Environ.* 41, 9370–9385.
- Khosla, P.K., Rubin, S.G. (1974). A diagonally dominant second-order accurate implicit scheme. *Comput. Fluids* 2, 207–209.
- Krüger, T. et al. (2017). *The Lattice Boltzmann Method: Principles and Practice*. Springer.
- Lenschow, P. et al. (2001). Some ideas about the sources of PM10. *Atmos. Environ.* 35 (Suppl. 1), S23–S33.
- Macdonald, R.W., Griffiths, R.F., Hall, D.J. (1998). An improved method for the estimation of surface roughness of obstacle arrays. *Atmos. Environ.* 32, 1857–1864.
- Macdonald, R.W. (2000). Modelling the mean velocity profile in the urban canopy layer. *Boundary-Layer Meteorol.* 97, 25–45.
- Patankar, S.V. (1980). *Numerical Heat Transfer and Fluid Flow*. Hemisphere.
- Paulson, C.A. (1970). The mathematical representation of wind speed and temperature profiles in the unstable atmospheric surface layer. *J. Appl. Meteorol.* 9, 857–861.
- Seinfeld, J.H., Pandis, S.N. (2016). *Atmospheric Chemistry and Physics*, 3rd ed. Wiley. (Briggs–McElroy–Pooler σ; Golder table.)
- Snyder, W.H. (1981). *Guideline for fluid modeling of atmospheric diffusion*. EPA-600/8-81-009.
- Soulhac, L., Fellini, S., Nguyen, C.V., Salizzoni, P. (2022). Simple photochemical modelling of NOx pollution in a street canyon. arXiv:2210.11859. **[V]**
- Sweby, P.K. (1984). High resolution schemes using flux limiters for hyperbolic conservation laws. *SIAM J. Numer. Anal.* 21, 995–1011.
- Tominaga, Y., Stathopoulos, T. (2007). Turbulent Schmidt numbers for CFD analysis with various types of flowfield. *Atmos. Environ.* 41, 8091–8099.
- Trebs, I. et al. (2009). Relationship between the NO₂ photolysis frequency and the solar global irradiance. *Atmos. Meas. Tech.* 2, 725–739. **[V]**
- Troen, I., Mahrt, L. (1986). A simple model of the atmospheric boundary layer; sensitivity to surface evaporation. *Boundary-Layer Meteorol.* 37, 129–148.
- Turner, D.B. (1964). A diffusion model for an urban area. *J. Appl. Meteorol.* 3, 83–91.
- Middleton, D.R., Luhana, L., Sokhi, R.S. (2007). *Review of methods for NO to NO₂ conversion in plumes at short ranges*. Environment Agency Science Report SC030171/SR2. **[V]**
- US EPA (2000). *Meteorological Monitoring Guidance for Regulatory Modeling Applications*, EPA-454/R-99-005 (Tables 6-4 to 6-7). **[V]**
- US EPA (2004/2019). *AERMOD Model Formulation*; AERMOD Implementation Guide (urban option, Eq. 110). **[V]** (formula)
- US EPA (2011). AP-42 §13.2.1 *Paved Roads*. **[V]**
- van Leer, B. (1974). Towards the ultimate conservative difference scheme II. *J. Comput. Phys.* 14, 361–370.
- Vitali, L. et al. (2023). A standardized methodology for the validation of air quality forecast applications (F-MQO). *Geosci. Model Dev.* 16, 6029–6047. **[V]**
- Wieringa, J. (1986). Roughness-dependent geographical interpolation of surface wind speed averages. *Q. J. R. Meteorol. Soc.* 112, 867–889.
- Wilson, J.D., Sawford, B.L. (1996). Review of Lagrangian stochastic models for trajectories in the turbulent atmosphere. *Boundary-Layer Meteorol.* 78, 191–210.

## The station, Zagreb and its traffic

The numbered list below is the source list of `docs/research/site-context.md` §8, kept with its numbering.

**Station, network and official reports**

1. ISZZ station metadata export (classification, parameters, start dates):
   https://iszz.azo.hr/iskzl/rs/postaja/eMetaList?id=155 and coordinates:
   https://iszz.azo.hr/iskzl/rs/postaja/koordinate
2. DHMZ station page, Zagreb 1: https://meteo.hr/kvaliteta_zraka.php?section=podaci_kz&post=Zagreb+1
   (its location text is wrong, see site-context §1.1).
3. DHMZ (2024), *Izvješće o praćenju kvalitete zraka na postajama Državne mreže ... za 2023.*:
   https://meteo.hr/kz/modeliranje/izvjesce_2023_kvaliteta_zraka.pdf. Source of the 2023 statistics in site-context §1.2.
4. HAOP/ZZOP report for 2024 (national): https://www.haop.hr/hr/novosti/izvjesce-o-pracenju-kvalitete-zraka-na-teritoriju-republike-hrvatske-za-2024-godinu
5. Grad Zagreb (Ekonerg), *Akcijski plan za poboljšanje kvalitete zraka na području Grada Zagreba* (SGGZ 5/15):
   https://eko.zagreb.hr/UserDocsImages/arhiva/dokumenti/Okoli%C5%A1/Zrak/Akcijski%20plan%20pobolj%C5%A1anja%20kvalitete%20zraka%20u%20GZ/Akcijski%20plan%20za%20pobolj%C5%A1anje%20kvalitete%20zraka%20na%20podru%C4%8Dju%20Grada%20Zagreba.pdf
   Contains the emission inventory, time profiles, Zagreb-1 diurnal and weekly analysis, climate and wind
   (Lisac 1984), traffic counts (Slavonska and Jadranska 2014, intersection totals 2009) and the station
   list with addresses.

**Traffic**

6. Fakultet prometnih znanosti (Dec 2017), *Prometna studija područja omeđenog željezničkom prugom, Avenijom
   Marina Držića, Ulicom grada Vukovara i Savskom cestom*:
   https://www.zagreb.hr/UserDocsImages/arhiva/prostorni_planovi/savjetovanje%20s%20javnoscu/prometna%20studija/FPZ_Gredelj_Tesktualni_dio.pdf
   Intersection PCU/h (Tablica 2), degree of saturation (Tablica 3) and LOS, queues and CO/NOx per approach
   (Tablice 8–9) for Miramarska–Vukovarska. It cites the FPZ et al. 2017 central-Zagreb VISSIM model.
7. Pejić G., Bunjevac M., Pečet M., Lulić Z. (2018), *Impact of introduction of low emission zones in the City
   of Zagreb*, Mobility & Vehicle Mechanics 44(4) 27–42:
   https://journals.indexcopernicus.com/api/file/viewByFileId/589859. Peak flows, speeds, the Zagreb Euro
   fleet and COPERT SL emissions; it names Zagreb-1 as the densest-traffic crossing.
8. Vujić M., Dedić L., Majstorović M. (2025), *The Modeling and Application of Dynamic Lane Assignment in Urban
   Areas: A Case Study of Vukovar Street in Zagreb*, Applied Sciences 15(12) 6479, doi:10.3390/app15126479.
   Uses 15-min, 7-day counts on Vukovarska; numbers not extracted because MDPI returned 403.
9. tportal (2019), *Neka zagrebačka raskršća dobila su oznaku F*:
   https://www.tportal.hr/vijesti/clanak/neka-zagrebacka-raskrsca-dobila-su-oznaku-f-evo-sto-to-znaci-foto-20190523
10. Hrvatske ceste (2025), *Brojenje prometa na cestama RH 2024*:
    https://hrvatske-ceste.hr/uploads/documents/attachment_file/file/1827/Brojenje_prometa_na_cestama_Republike_Hrvatske_godine_2024.pdf
    Covers state and county roads only; it has no Zagreb city streets.
11. CVH vehicle statistics (fleet by county and fuel, age): https://www.cvh.hr/gradani/tehnicki-pregled/statistika/
    (xlsx files `/media/5439/…`, `/media/5423/…`, `/media/5429/…`, `/media/5431/…`).
12. Vukić L. (2025), *Mitigation of Urban Air Pollution in Croatia: Current Trends in Establishing Low-Emission
    Zones*, Transportation Research Procedia, doi:10.1016/j.trpro.2025.10.054

**Air quality science using Zagreb data**

13. Bešlić I., Sopčić S., Sever Štrukil Z., Mihajlović D. (2026), *Influence of Mixing Layer Height on Air
    Pollution in the City of Zagreb*, Climate 14(7) 133, doi:10.3390/cli14070133
14. Davila S., Sopčić S., Pehnec G., Bešlić I. (2026), *Annual Levoglucosan Variability ... Urban Background
    Site in Croatia*, Environments 13(4) 196, doi:10.3390/environments13040196. Wood-burning tracer; annual
    PM10 22 µg/m³ at the urban background site.
15. Sopčić S., Pehnec G., Bešlić I. (2024), *Specific biomass burning tracers in air pollution in Zagreb*,
    Atmos. Pollut. Res., doi:10.1016/j.apr.2024.102176
16. Račić N., Ružičić S., Terzić T., Pehnec G., Jakovljević I., Sever Štrukil Z. (2024), *Analyzing the
    relationship between gas consumption and airborne pollutants: case study of Zagreb*, AQAH,
    doi:10.1007/s11869-024-01655-7. Identifies heating and traffic as the main sources.
17. Jakovljević I., Sever Štrukil Z., Godec R., Davila S., Pehnec G. (2020), *Influence of lockdown caused by the
    COVID-19 pandemic on air pollution and carcinogenic content of PM observed in Croatia*, AQAH,
    doi:10.1007/s11869-020-00950-3. Reports NO2 about −35 % at the traffic site during the lockdown (from a
    search snippet).
18. Lovrić M. et al. (2022), *Machine Learning and Meteorological Normalization for Assessment of PM Changes
    during the COVID-19 Lockdown in Zagreb*, IJERPH 19, 6937, doi:10.3390/ijerph19116937
19. Šišović A., Pehnec G., Jakovljević I. et al. (2012), *Polycyclic Aromatic Hydrocarbons at Different
    Crossroads in Zagreb*, Bull. Environ. Contam. Toxicol., doi:10.1007/s00128-011-0516-4. PAHs at traffic
    crossroads.
20. Kranjčić N., Dogančić D., Đurin B., Ptiček Siročić A. (2022), *Analyzing Air Pollutant Reduction
    Possibilities in the City of Zagreb*, ISPRS IJGI 11(4) 259, doi:10.3390/ijgi11040259. Uses Zagreb-1 and
    describes its siting (see site-context §1.1).
21. Petrić V., Račić N., Hrga I., Grgec D., Marić M., Krivohlavek A. (2025), *Assessment of Sensor Data from an
    Air Quality Monitoring Network — ML-Based Recalibration*, Atmosphere 16(12) 1358,
    doi:10.3390/atmos16121358. 35 sensors in Zagreb against national reference stations; uses traffic
    proxies.
22. Davila S. et al. (2025), *Comparison of Sensors for Air Quality Monitoring with Reference Methods in Zagreb*,
    Atmosphere 16(4) 472, doi:10.3390/atmos16040472
23. Perrone M.G. et al. (2018), *Sources and geographic origin of PM in urban areas of the Danube macro-region:
    Zagreb, Budapest and Sofia*: https://pmc.ncbi.nlm.nih.gov/articles/PMC5821697/. Receptor modelling finds
    traffic, biomass burning and secondary aerosol to be the main PM sources in Zagreb.
24. Belis C.A. et al. (2019), *Urban pollution in the Danube and Western Balkans regions: the impact of major
    PM2.5 sources*: https://pmc.ncbi.nlm.nih.gov/articles/PMC6839612/
25. Levels of nitrogen dioxide in the Zagreb air, 1994–1998: https://pubmed.ncbi.nlm.nih.gov/11103527/
26. Lisac I. (1984), *Vjetar u Zagrebu (Prilog poznavanju klime grada Zagreba, II)*, Geofizika 1. Wind
    climatology, cited via the Action Plan.

**Power and heating**

27. HEP, EL-TO new CCGT unit L (150 MWe / 114 MWth, gas, from Nov 2023):
    https://balkangreenenergynews.com/croatias-hep-starts-up-new-unit-at-cogeneration-plant-in-zagreb/ ;
    https://www.hep.hr/projects/el-to-zagreb-ccpp/2549
28. Eko Zagreb, household heating shares: https://eko.zagreb.hr/grijanje/105
