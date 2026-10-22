# Builds details.json from thefifthmatt's pattern spreadsheet (patterns 000-319 only; the sheet has no DLC patterns).
# Usage: python make_details.py patterns.csv details.json
# Coordinates are % of thefifthmatt's map images (x west->east, y north->south), read off patterns 000/001/005/030/031.
import csv, json, sys

XY = {
    "Castle:Castle": (45.5, 53.5), "Arena Boss:Castle Basement": (47, 55.5), "Field Boss:Castle Rooftop": (44, 52),
    "Major Base:South Lake": (39.6, 78.5), "Major Base:Groveside": (27.7, 66.8), "Major Base:Gatefront": (32, 56.7),
    "Major Base:Stormhill North of Gate": (27.6, 45.2), "Major Base:Alexander Spot": (41.3, 30.3),
    "Major Base:Northwest Stormhill": (22.5, 27.8), "Major Base:Northeast Stormhill": (40.5, 18.2),
    "Major Base:South Mistwood": (74.6, 75), "Major Base:Waypoint Ruins": (61.5, 70), "Major Base:Minor Erdtree": (75, 64.7),
    "Major Base:West Mistwood": (63.1, 60.5), "Major Base:Northwest Mistwood": (66.5, 47.3), "Major Base:Artist's Shack": (58.7, 43),
    "Major Base:Northeast Mistwood": (76.9, 42.6), "Major Base:Summonwater Approach": (62.7, 29.6), "Major Base:Summonwater": (71.1, 22),
    "Minor Base:Far Southwest": (20, 71.2), "Minor Base:Lake": (45.2, 69), "Minor Base:Stormhill South of Gate": (20.3, 56.3),
    "Minor Base:Above Stormhill Tunnel Entrance": (35.8, 39.3), "Minor Base:West of Warmaster's Shack": (21.7, 34.8),
    "Minor Base:Southeast of Lake": (56.5, 80.5), "Minor Base:East of Cavalry Bridge": (55, 63.5), "Minor Base:Minor Erdtree": (80.5, 58),
    "Minor Base:Below Summonwater Hawk": (69.1, 36.2), "Minor Base:Third Church": (78, 35.5), "Minor Base:Northeast of Saintsbridge": (53.3, 22.2),
    "Evergaol:Northwest of Lake": (34.8, 62.7), "Evergaol:Murkwater Terminus": (44.5, 37), "Evergaol:Stormhill": (16.5, 30),
    "Evergaol:Highroad": (48, 19.5), "Evergaol:East of Lake": (57.7, 76), "Evergaol:Mistwood": (78.7, 49), "Evergaol:Northeast Tunnel Entrance": (62.7, 35.5),
    "Field Boss:Far Southwest of Lake": (31, 82.8), "Field Boss:Lake": (43, 71.4), "Field Boss:North of Stormhill Tunnel Entrance": (31, 37.1),
    "Field Boss:North of Murkwater Terminus": (46.9, 35.6), "Field Boss:Stormhill Spectral Hawk": (33.3, 23.8),
    "Field Boss:Northwest Stormhill Cliffside": (29.3, 19), "Field Boss:Mistwood Spectral Hawk": (68.2, 77.9), "Field Boss:North Mistwood": (76.2, 51),
    "Field Boss:East of Murkwater Terminus": (54.9, 37.9), "Field Boss:Northwest of Summonwater": (63.5, 21.6),
    "Rotted Woods:Southwest": (64.8, 74.2), "Rotted Woods:Southeast": (78, 68.8), "Rotted Woods:Center West": (60.2, 62.2),
    "Rotted Woods:Center East": (71.6, 63.5), "Rotted Woods:Far Northwest": (56.7, 56.4), "Rotted Woods:Northwest": (61.9, 55.8),
    "Rotted Woods:Northeast": (76, 60), "Rotted Woods:Far Northeast": (78.5, 56.5),
}
CIRCLES = {
    "West Stormhill Graveyard": (21.3, 38.5), "Northeast Corner": (80.3, 23.5), "Northwest Corner": (21.2, 21.5), "South Lake": (47.1, 77.2),
    "Southwest Corner": (26.1, 74.9), "Northwest Mistwood Pond": (70.7, 53.5), "Southwest Mistwood": (69, 69), "Northwest of Castle": (36.5, 45.3),
    "Northeast of Lake": (55.6, 53.5), "East of Saintsbridge": (55.6, 25.6), "Northwest Lake": (36, 69), "South of Castle": (42.9, 62),
    "North of Crater": (48, 18.2), "Southeast Mountaintop": (40.4, 37.9), "Noklateo Entrance": (43.4, 54.7),
    "Northwest Rotted Woods": (72.7, 54.2), "Southeast Rotted Woods": (61.2, 68.7),
}
LABEL = {"Castle": "Castle", "Arena Boss": "Castle basement boss", "Evergaol": "Evergaol", "Field Boss": "Field boss", "Rotted Woods": "Rotted Woods boss"}

rows = list(csv.reader(open(sys.argv[1], encoding="utf-8")))
kinds, names, data = rows[0], rows[1], rows[2:]
cols = range(10, 65)  # Castle .. Rotted Woods columns
slots = []
for c in cols:
    key = f"{kinds[c]}:{names[c]}"
    assert key in XY, key
    if names[c] == "Castle Rooftop":
        kind = "Castle rooftop boss"
    else:
        kind = LABEL.get(kinds[c], "")  # bases carry their type in the value ("Fort - Crystalians")
    slots.append({"name": names[c], "kind": kind, "x": XY[key][0], "y": XY[key][1]})
spawn_xy = {s["name"]: [s["x"], s["y"]] for c, s in zip(cols, slots) if kinds[c] == "Minor Base"}

values = [""]
index = {"": 0}
patterns = {}
for row in data:
    pid = f"{int(row[0]):03d}"
    for circle in (row[8], row[9]):
        assert circle in CIRCLES, (pid, circle)
    assert row[3] in spawn_xy, (pid, row[3])
    v = []
    for c in cols:
        if row[c] not in index:
            index[row[c]] = len(values)
            values.append(row[c])
        v.append(index[row[c]])
    patterns[pid] = {"event": row[4], "n1": [row[5], row[8]], "n2": [row[6], row[9]], "extra": row[7],
                     "merchant": row[67], "frenzy": row[66], "blessing": row[65], "spawn": row[3], "v": v}

json.dump({"slots": slots, "values": values, "circles": CIRCLES, "spawns": spawn_xy, "patterns": patterns},
          open(sys.argv[2], "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
print(len(slots), "slots,", len(values), "values,", len(patterns), "patterns")
