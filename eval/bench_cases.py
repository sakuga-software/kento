"""The cases of the first bench (REV-121).

The cases come from private repositories, so this repository does not hold them. BENCH_CASES names
the folder of the internal bench that holds them:

- cases.tsv: one case a line: a name, the repository, the base commit and the head commit;
- truth.json: for each case, its defects: {"<case>": {"G1": ["<path regex>", "<text regex>"]}}.
  A case with no defect is a clean pull request: each blocking finding on it is a false positive.
"""
import json
import os
import sys


def cases_dir():
    path = os.environ.get("BENCH_CASES")
    if not path:
        sys.exit("BENCH_CASES must name the folder of the internal bench that holds cases.tsv and truth.json")
    return path


def read_cases(only=None):
    with open(os.path.join(cases_dir(), "cases.tsv")) as f:
        cases = [line.rstrip("\n").split("\t") for line in f if line.strip()]
    return [c for c in cases if not only or c[0] in only]


def read_truth():
    with open(os.path.join(cases_dir(), "truth.json")) as f:
        return {case: {gid: tuple(pair) for gid, pair in defects.items()} for case, defects in json.load(f).items()}
