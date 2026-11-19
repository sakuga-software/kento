"""Aggregate the runs of one or more labels per model.

    python3 judge.py <label> [<label> ...]        # table per model
    SHOW=1 python3 judge.py <label>               # also print each candidate match

BENCH_CASES names the folder of the internal bench that holds truth.json (bench_cases.py).
A hit is a finding whose path and text match the expected defect. The patterns
only propose a match: read the SHOW output before you trust a number.
"""
import collections
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, HERE)
from bench_cases import read_truth  # noqa: E402

TRUTH = read_truth()
CASE = "|".join(sorted(map(re.escape, TRUTH), key=len, reverse=True))
PRICE_SPLIT = re.compile(rf"^(?P<label>[^-]+)-(?P<model>[a-z0-9.-]+_[^-]+(?:-[^-]+)*?)-(?P<case>{CASE})\.json$")


def main():
    labels = sys.argv[1:]
    show = os.environ.get("SHOW")
    stats = collections.defaultdict(lambda: {"runs": 0, "cost": 0.0, "hits": collections.Counter(), "invalid": 0,
                                             "blocking_other": 0, "clean_block": 0, "clean_runs": 0, "calls": 0})
    for label in labels:
        for path in sorted(glob.glob(os.path.join(HERE, "runs", f"{label}-*.json"))):
            m = PRICE_SPLIT.match(os.path.basename(path))
            if not m:
                continue
            model, case = m.group("model"), m.group("case")
            r = json.load(open(path))
            s = stats[model]
            s["runs"] += 1
            s["cost"] += (r.get("usage") or {}).get("cost") or 0
            s["calls"] += r.get("tool_calls") or 0
            a = r.get("answer")
            if not isinstance(a, dict) or "invalid" in a or "findings" not in a:
                s["invalid"] += 1
                continue
            if not TRUTH[case]:
                s["clean_runs"] += 1
                if a["verdict"] == "request_changes":
                    s["clean_block"] += 1
            for f in a["findings"]:
                text = f"{f.get('title','')} {f.get('scenario','')}"
                matched = None
                for gid, (path_re, text_re) in TRUTH[case].items():
                    if re.search(path_re, f.get("path", "")) and re.search(text_re, text, re.I):
                        matched = gid
                        break
                if matched:
                    s["hits"][f"{case}:{matched}"] += 1
                    if show:
                        print(f"HIT {model} {label} {case}:{matched} [{f['severity']}/{f['confidence']}] {f['path'].split('/')[-1]}:{f['line']} {f['title'][:160]}")
                elif f["severity"] in ("critical", "major"):
                    s["blocking_other"] += 1
    total = sum(len(v) for v in TRUTH.values())
    print(f"{'model':34} runs inval  hits/run  distinct  other-blocking  clean-block  €/review  tools/run")
    for model, s in sorted(stats.items(), key=lambda kv: -sum(kv[1]["hits"].values()) / max(kv[1]["runs"], 1)):
        valid = s["runs"] - s["invalid"]
        print(f"{model:34} {s['runs']:4} {s['invalid']:5}  {sum(s['hits'].values()) / max(len(labels), 1):6.1f}/{total}"
              f"  {len(s['hits']):8}  {s['blocking_other'] / max(valid, 1):14.2f}  {s['clean_block']}/{s['clean_runs']:<9}"
              f"  {s['cost'] / max(s['runs'], 1):8.4f}  {s['calls'] / max(s['runs'], 1):6.1f}")


main()
