"""One review in one model call, for the eval.

    python3 oneshot.py <label> <model> [<model> ...]

Reads eval/cases.tsv, builds the pack of each case with context-pack.sh, and
writes runs/<label>-<model>-<case>.json with the answer and the token usage.
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "https://openrouter.ai/api/v1/chat/completions"
KEY = subprocess.check_output(
    ["security", "find-generic-password", "-s", "openrouter-pr-review", "-a", "api-key", "-w"], text=True
).strip()
PROMPT = open(os.path.join(HERE, os.environ.get("PROMPT", "review-prompt-oneshot.md"))).read()

FINDING = {
    "type": "object",
    "properties": {
        "path": {"type": "string"},
        "line": {"type": "integer"},
        "severity": {"type": "string", "enum": ["critical", "major", "minor"]},
        "confidence": {"type": "integer"},
        "title": {"type": "string"},
        "scenario": {"type": "string"},
        "fix": {"type": "string"},
    },
    "required": ["path", "line", "severity", "confidence", "title", "scenario", "fix"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["approve", "request_changes", "comment"]},
        "pr_confidence": {"type": "integer"},
        "summary": {"type": "string"},
        "findings": {"type": "array", "items": FINDING},
        "not_reviewed": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["verdict", "pr_confidence", "summary", "findings", "not_reviewed"],
    "additionalProperties": False,
}


def pack(worktree, base):
    return subprocess.check_output(["bash", os.path.join(HERE, "context-pack.sh"), base], cwd=worktree, text=True)


def review(model, case, worktree, base, label):
    body = {
        "model": model,
        "max_tokens": int(os.environ.get("MAX_TOKENS", "16000")),
        "reasoning": {"effort": "low"},
        "usage": {"include": True},
        # No provider that keeps or trains on the prompts, and only providers that honour the schema.
        "provider": {"zdr": True, "data_collection": "deny", "require_parameters": True},
        "messages": [{"role": "system", "content": PROMPT}, {"role": "user", "content": pack(worktree, base)}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "review", "strict": True, "schema": SCHEMA}},
    }
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            out = json.load(res)
        content = out["choices"][0]["message"]["content"]
        try:
            answer = json.loads(content)
        except Exception:
            answer = {"invalid": content}
        result = {"answer": answer, "usage": out.get("usage"), "provider": out.get("provider"), "seconds": round(time.time() - start)}
    except Exception as error:
        result = {"error": str(error), "seconds": round(time.time() - start)}
    with open(os.path.join(HERE, "runs", f"{label}-{model.replace('/', '_')}-{case}.json"), "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)


def main():
    os.makedirs(os.path.join(HERE, "runs"), exist_ok=True)
    label, models = sys.argv[1], sys.argv[2:]
    only = os.environ.get("CASES", "").split(",") if os.environ.get("CASES") else None
    cases = [line.rstrip("\n").split("\t") for line in open(os.path.join(HERE, "cases.tsv"))]
    cases = [c for c in cases if not only or c[0] in only]
    jobs = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=int(os.environ.get("WORKERS", "8"))) as pool:
        for model in models:
            for name, _repo, base, _head in cases:
                worktree = os.path.join(HERE, "..", os.environ.get("WORKTREES", "wt"), name)
                jobs.append(pool.submit(review, model, name, worktree, base, label))
        for job in jobs:
            job.result()


main()
