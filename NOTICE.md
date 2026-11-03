# Notice: data, attribution and trademarks

The [MIT license](LICENSE) covers **this repository's code and original assets only**
(including the hand-built models in `assets-src/`). It does **not** cover the data the
pipeline downloads or the files it generates.

## Data sources (each keeps its own terms)

| Source | Used for | Terms |
|---|---|---|
| [FastF1](https://github.com/theOehrly/Fast-F1) (MIT) reading Formula 1's unofficial live-timing feed | Lap timing, car telemetry, positions | The data belongs to Formula 1 / its rights holders. This project claims no rights to it and is **non-commercial**. Generated race files are a rebuildable cache and are not committed or offered as a dataset. |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass | Roads, buildings, landcover | © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). Attribution is shown in the app. |
| [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium) on AWS Open Data | Elevation | Built from SRTM, GMTED, NED, ETOPO1 and others; see the attribution list at the link. |

If you run the pipeline yourself you are responsible for complying with these terms,
including the [Overpass usage policy](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances)
(be gentle: the pipeline caches tiles; don't hammer the public instance).

## Trademarks

Unofficial project. Not affiliated with, endorsed by, or connected to Formula 1, the FIA or any team.
F1, FORMULA 1, FORMULA ONE, GRAND PRIX and related marks are trademarks of Formula One Licensing B.V.
Team and driver names are used only to identify factual race data. Livery colours are colour schemes only;
no logos, sponsor marks or official artwork are included. The MIT license does not grant any trademark rights.

## Takedown

If you are a rights holder and want something removed from the hosted site, open an issue or email
the maintainer and it will be handled promptly.
