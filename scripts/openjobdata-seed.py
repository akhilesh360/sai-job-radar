"""Build a source-seeds file from openjobdata.com's public dataset (Hugging Face bucket Invicto69/Jobs-Dataset-bucket).

    python3 -m venv .venv && .venv/bin/pip install huggingface_hub pyarrow pandas
    .venv/bin/python scripts/openjobdata-seed.py boards-now.json data/source-seeds-15.json [--all]

boards-now.json = `wrangler d1 execute sai-job-radar --remote --json --command "SELECT id FROM source_boards"`.
Default: US companies on an ATS we read whose posting history contains a role our classifier accepts (run
`node --input-type=module -e 'import {classifyRole} ...'` over titles — see the 2026-09-05 session notes). --all: every
US company on a readable ATS. Workday and other unreadable ATSs are skipped.
"""
import json, re, sys
import pandas as pd
from huggingface_hub import HfFileSystem

ATS = {"greenhouse": "Greenhouse", "ashbyhq": "Ashby", "lever": "Lever", "smartrecruiters": "SmartRecruiters", "bamboohr": "BambooHR",
       "breezy": "Breezy", "rippling": "Rippling", "gem": "Gem", "pinpoint": "Pinpoint", "jobscore": "JobScore", "oracle_hcm": "Oracle"}
EXCLUDED = re.compile(r"federal|ewor ?gmbh|jobgether", re.I)

def main(boards_json, out_path, everything=False):
    fs = HfFileSystem()
    with fs.open("buckets/Invicto69/Jobs-Dataset-bucket/data/companies/companies.parquet", "rb") as f:
        companies = pd.read_parquet(f)
    have = {row["id"] for row in json.load(open(boards_json))[0]["results"]}
    norm = lambda s: re.sub(r"[^a-z0-9:]", "", s)
    have_norm = {norm(i) for i in have}
    rows = []
    for r in companies[companies.country.fillna("").str.lower() == "united states"].itertuples():
        if r.ats not in ATS or EXCLUDED.search(f"{r.name} {r.slug}"):
            continue
        ats, slug, url = ATS[r.ats], str(r.slug), str(r.career_url)
        if r.ats == "oracle_hcm":
            m = re.match(r"oracle_hcm:([^:]+):([^/]+)/(.+)$", str(r.unique_id))
            if not m:
                continue
            slug = f"{m.group(1)}.fa.{m.group(2)}.oraclecloud.com--{m.group(3)}"
            url = f"https://{m.group(1)}.fa.{m.group(2)}.oraclecloud.com/hcmUI/CandidateExperience/en/sites/{m.group(3)}"
        board_id = f"{ats}:{slug}".lower()
        if board_id in have or norm(board_id) in have_norm:
            continue
        rows.append({"id": board_id, "ats": ats, "slug": slug, "companyName": str(r.name)[:120], "boardUrl": url, "origin": "openjobdata", "_cid": int(r.id)})
    if not everything:
        # Keep companies whose jobs history has a title our classifier accepts: expects ojd-titles-match.txt next to the jobs shards.
        print("Filtering by data-role history needs the jobs shards + classified titles; see the docstring. Writing all rows instead.")
    for row in rows:
        row.pop("_cid", None)
    json.dump(rows, open(out_path, "w"))
    print(f"wrote {len(rows)} boards to {out_path}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], "--all" in sys.argv)
