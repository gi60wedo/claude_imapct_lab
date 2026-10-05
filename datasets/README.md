# Datasets: Nuremberg Altstadt

Run `./fetch.sh` to download everything (~590 MB). Coverage is the Altstadt bbox
EPSG:25832 `649600,5478800 – 651700,5480900` (WGS84 `49.444,11.065 – 49.461,11.092`).

| Folder | Content | Format | Source |
|---|---|---|---|
| `lod2/` | 3D buildings with heights and roofs, four 2 km tiles | CityGML, EPSG:25832 | LDBV Bayern open data |
| `dgm1/` | 1 m terrain elevation, nine 1 km tiles | GeoTIFF | LDBV Bayern open data |
| `dop20/` | Aerial photo, 4 quadrants at 0.25 m/px | JPEG, bbox in filename | LDBV DOP20 WMS |
| `alkis/` | Parcel and building outlines, 4 quadrants | transparent PNG, bbox in filename | LDBV ALKIS Parzellarkarte WMS |
| `osm/altstadt.json` | Streets, footways, barriers, U-Bahn entrances, elevators, shops, amenities, buildings | Overpass JSON with geometry | OpenStreetMap |
| `gtfs/vgn_gtfs.zip` | VGN timetables for U-Bahn arrival peaks | GTFS | VGN open data |

Image filenames encode the bbox as `minx_miny_maxx_maxy` in EPSG:25832.

## Attribution
- Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de, CC BY 4.0
- © OpenStreetMap contributors, ODbL
- VGN Verkehrsverbund Großraum Nürnberg, open data license (see vgn.de/opendata)
