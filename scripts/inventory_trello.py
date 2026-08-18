import zipfile, json, pathlib, collections, sys
p=pathlib.Path(sys.argv[1])
out=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else "trello_inventory.json")
rows=[]
with zipfile.ZipFile(p) as z:
    for n in z.namelist():
        if n.endswith("card_metadata.json"):
            d=json.loads(z.read(n))
            folder=str(pathlib.PurePosixPath(n).parent)
            images=[x for x in z.namelist() if str(pathlib.PurePosixPath(x).parent)==folder and x.lower().endswith((".png",".jpg",".jpeg",".webp"))]
            rows.append({"card_id":d.get("id"),"card_name":d.get("name"),"handle":(d.get("name") or "").split()[0].lstrip("@"),"stage":d.get("list"),"description":d.get("description"),"labels":[x.get("name") for x in d.get("labels",[])],"images":images})
out.write_text(json.dumps(rows,indent=2,ensure_ascii=False),encoding="utf-8")
print(f"Wrote {len(rows)} cards to {out}")
