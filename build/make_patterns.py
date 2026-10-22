# Builds patterns.json from thefifthmatt's Nightlord pages: {slug: [[id, terrain, spawn], ...]} in sprite order.
import json, re, sys, urllib.request

SLUGS = ["gladius", "adel", "gnoster", "maris", "libra", "fulghor", "caligo", "heolstor", "harmonia", "straghess"]
SUFFIX = {"Mountaintop": "mountaintop", "Crater": "crater", "Rotted Woods": "rotted", "Noklateo": "noklateo", "Great Hollow": "hollow"}
# Terrain by position in a Nightlord's ID list, as seen on the thumbnails (base game: 50 patterns, DLC Nightlords: 60).
BLOCKS = {50: ["none"] * 20 + ["mountaintop"] * 5 + ["crater"] * 5 + ["rotted"] * 5 + ["noklateo"] * 5 + ["none"] * 5 + ["hollow"] * 5,
          60: ["none"] * 20 + ["mountaintop"] * 5 + ["crater"] * 5 + ["rotted"] * 5 + ["hollow"] * 20 + ["noklateo"] * 5}

out = {}
for slug in SLUGS:
    html = urllib.request.urlopen(f"https://thefifthmatt.github.io/nightreign/{slug}/").read().decode()
    idgrid = html[html.index('id="idgrid"'):html.index('id="spawngrid"')]
    ids = re.findall(r'href="(\d+)\.html"', idgrid)
    spawn = {}
    for legend, body in re.findall(r"<legend>(.*?)</legend>(.*?)</fieldset>", html[html.index('id="spawngrid"'):], re.S):
        for i in re.findall(r'href="(\d+)\.html"', body):
            spawn[i] = legend.replace("&#39;", "'").replace("&amp;", "&")
    rows = []
    for pos, i in enumerate(ids):
        m = re.match(r"(.*) \((.*)\)$", spawn[i])
        terrain = SUFFIX[m.group(2)] if m and m.group(2) in SUFFIX else "none"
        assert terrain == BLOCKS[len(ids)][pos], (slug, i, spawn[i])
        rows.append([i, terrain, m.group(1) if m and m.group(2) in SUFFIX else spawn[i]])
    out[slug] = rows

json.dump(out, open(sys.argv[1], "w"), separators=(",", ":"))
print({s: len(r) for s, r in out.items()})
