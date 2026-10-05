#!/usr/bin/env bash
# Downloads open geodata for the Nuremberg Altstadt (EPSG:25832 bbox 649600,5478800 – 651700,5480900).
set -u
cd "$(dirname "$0")"
mkdir -p lod2 dgm1 dop20 alkis osm gtfs
B=https://download1.bayernwolke.de/a
get() { curl -sS -L --retry 3 -C - -o "$2" "$1" && echo "ok   $2 $(du -h "$2" | cut -f1)" || echo "FAIL $2"; }

for t in 648_5478 650_5478 648_5480 650_5480; do get "$B/lod2/citygml/$t.gml" "lod2/$t.gml"; done
for x in 649 650 651; do for y in 5478 5479 5480; do get "$B/dgm/dgm1/${x}_$y.tif" "dgm1/${x}_$y.tif"; done; done

# DOP20 orthophoto and ALKIS parcel map via WMS, as 4 quadrant tiles at 0.25 m/px
for qx in 0 1; do for qy in 0 1; do
  x0=$((649600+qx*1050)); y0=$((5478800+qy*1050)); bb="$x0,$y0,$((x0+1050)),$((y0+1050))"
  get "https://geoservices.bayern.de/od/wms/dop/v1/dop20?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=by_dop20c&STYLES=&SRS=EPSG:25832&BBOX=$bb&WIDTH=4200&HEIGHT=4200&FORMAT=image/jpeg" "dop20/dop20_${bb//,/_}.jpg"
  get "https://geoservices.bayern.de/od/wms/alkis/v1/parzellarkarte?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=by_alkis_parzellarkarte_umr_gelb&STYLES=&SRS=EPSG:25832&BBOX=$bb&WIDTH=2100&HEIGHT=2100&FORMAT=image/png&TRANSPARENT=true" "alkis/parzellarkarte_${bb//,/_}.png"
done; done

# OSM: walking network, transit, barriers, POIs, buildings (WGS84 bbox)
Q='[out:json][timeout:180];(way["highway"](49.444,11.065,49.461,11.092);node["barrier"](49.444,11.065,49.461,11.092);way["barrier"](49.444,11.065,49.461,11.092);nwr["public_transport"](49.444,11.065,49.461,11.092);nwr["railway"~"subway_entrance|station|stop"](49.444,11.065,49.461,11.092);node["highway"="elevator"](49.444,11.065,49.461,11.092);nwr["amenity"](49.444,11.065,49.461,11.092);nwr["shop"](49.444,11.065,49.461,11.092);nwr["building"](49.444,11.065,49.461,11.092);nwr["place"="square"](49.444,11.065,49.461,11.092););out body geom;'
curl -sS -A "urbantwin-hackathon/0.1" --data-urlencode "data=$Q" -o osm/altstadt.json https://overpass.private.coffee/api/interpreter && echo "ok   osm/altstadt.json $(du -h osm/altstadt.json | cut -f1)" || echo "FAIL osm"

get https://www.vgn.de/opendata/GTFS.zip gtfs/vgn_gtfs.zip
echo DONE
