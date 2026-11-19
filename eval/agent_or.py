"""One review by a short agent loop, for the eval.

    ROUNDS=4 python3 agent_or.py <label> <model> [<model> ...]

The first message holds the same pack as oneshot_or.py. The model then has at
most ROUNDS rounds of read-only tools. A last call with no tool asks for the
answer, so every run ends with a JSON object.
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bench_cases import cases_dir, read_cases  # noqa: E402

cases_dir()  # Stop before the key and any call when BENCH_CASES is not set.
URL = "https://openrouter.ai/api/v1/chat/completions"
KEY = subprocess.check_output(
    ["security", "find-generic-password", "-s", "openrouter-pr-review", "-a", "api-key", "-w"], text=True
).strip()
ROUNDS = int(os.environ.get("ROUNDS", "4"))
MAX_TOOL_LINES = 300

SCHEMA = json.loads(open(os.path.join(HERE, "schema.json")).read())

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read lines of a file of the repository, at most 300 lines per call.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path from the repository root."},
                    "start_line": {"type": "integer"},
                    "end_line": {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": "Search the repository with an extended regular expression (git grep -n -E). "
            "Returns at most 80 matching lines.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path_glob": {"type": "string", "description": "Optional pathspec, for example 'apps/app/**/*.ts'."},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List the entries of a directory of the repository.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
        },
    },
]


def inside(worktree, path):
    full = os.path.realpath(os.path.join(worktree, path.lstrip("/")))
    if not full.startswith(os.path.realpath(worktree) + os.sep) and full != os.path.realpath(worktree):
        raise ValueError("path outside the repository")
    return full


def run_tool(worktree, name, args):
    try:
        if name == "read_file":
            full = inside(worktree, args["path"])
            lines = open(full, errors="replace").read().splitlines()
            start = max(int(args.get("start_line") or 1), 1)
            end = min(int(args.get("end_line") or start + MAX_TOOL_LINES - 1), start + MAX_TOOL_LINES - 1, len(lines))
            return "\n".join(f"{i}\t{lines[i - 1]}" for i in range(start, end + 1)) or "(empty range)"
        if name == "search":
            cmd = ["git", "grep", "-n", "-E", "-I", args["pattern"]]
            if args.get("path_glob"):
                cmd += ["--", args["path_glob"]]
            out = subprocess.run(cmd, cwd=worktree, capture_output=True, text=True, timeout=30).stdout.splitlines()
            return "\n".join(out[:80]) + (f"\n... {len(out) - 80} more" if len(out) > 80 else "") or "(no match)"
        if name == "list_dir":
            full = inside(worktree, args.get("path") or ".")
            return "\n".join(sorted(e + ("/" if os.path.isdir(os.path.join(full, e)) else "") for e in os.listdir(full)))
        return f"unknown tool {name}"
    except Exception as error:
        return f"error: {error}"


def call(body):
    req = urllib.request.Request(
        URL, data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=600) as res:
        return json.load(res)


def review(model, case, worktree, base, label, prompt, pack):
    common = {
        "model": model,
        "max_tokens": int(os.environ.get("MAX_TOKENS", "16000")),
        "reasoning": {"effort": "low"},
        "usage": {"include": True},
        "provider": {"zdr": True, "data_collection": "deny", "require_parameters": True},
    }
    user = {"type": "text", "text": pack + f"\n\nYou have at most {ROUNDS} rounds of tool calls. Use them only to "
            "check a caller, a definition or a guard that decides a finding. Then answer."}
    if model.startswith("anthropic/"):
        user["cache_control"] = {"type": "ephemeral"}
    messages = [{"role": "system", "content": prompt}, {"role": "user", "content": [user]}]
    log, cost, tokens_in, tokens_out, tool_calls = [], 0.0, 0, 0, 0
    start = time.time()
    try:
        for _ in range(ROUNDS):
            out = call({**common, "messages": messages, "tools": TOOLS, "tool_choice": "auto"})
            u = out.get("usage") or {}
            cost += u.get("cost") or 0
            tokens_in += u.get("prompt_tokens") or 0
            tokens_out += u.get("completion_tokens") or 0
            log.append({"cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens"), "cost": u.get("cost")})
            msg = out["choices"][0]["message"]
            calls = msg.get("tool_calls") or []
            if not calls:
                break
            messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
            for c in calls:
                tool_calls += 1
                try:
                    args = json.loads(c["function"].get("arguments") or "{}")
                except Exception:
                    args = {}
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": run_tool(worktree, c["function"]["name"], args)})
        messages.append({"role": "user", "content": "Answer now with the JSON object only."})
        out = call({**common, "messages": messages, "tools": TOOLS, "tool_choice": "none",
                    "response_format": {"type": "json_schema", "json_schema": {"name": "review", "strict": True, "schema": SCHEMA}}})
        u = out.get("usage") or {}
        cost += u.get("cost") or 0
        tokens_in += u.get("prompt_tokens") or 0
        tokens_out += u.get("completion_tokens") or 0
        log.append({"cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens"), "cost": u.get("cost")})
        content = out["choices"][0]["message"].get("content") or ""
        try:
            answer = json.loads(content[content.index("{"): content.rindex("}") + 1])
        except Exception:
            answer = {"invalid": content[:2000]}
        result = {"answer": answer, "usage": {"cost": cost, "prompt_tokens": tokens_in, "completion_tokens": tokens_out},
                  "tool_calls": tool_calls, "calls": log, "provider": out.get("provider")}
    except Exception as error:
        detail = error.read().decode()[:500] if hasattr(error, "read") else ""
        result = {"error": f"{error} {detail}", "usage": {"cost": cost}, "calls": log}
    result["seconds"] = round(time.time() - start)
    with open(os.path.join(HERE, "runs", f"{label}-{model.replace('/', '_')}-{case}.json"), "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)


def main():
    os.makedirs(os.path.join(HERE, "runs"), exist_ok=True)
    label, models = sys.argv[1], sys.argv[2:]
    prompt = open(os.path.join(HERE, os.environ.get("PROMPT", "review-prompt-agent.md"))).read()
    only = os.environ.get("CASES", "").split(",") if os.environ.get("CASES") else None
    cases = read_cases(only)
    packs = {}
    for name, _repo, base, _head in cases:
        wt = os.path.join(HERE, "..", os.environ.get("WORKTREES", "wt"), name)
        packs[name] = subprocess.check_output(["bash", os.path.join(HERE, "context-pack.sh"), base], cwd=wt, text=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=int(os.environ.get("WORKERS", "8"))) as pool:
        jobs = [pool.submit(review, m, n, os.path.join(HERE, "..", os.environ.get("WORKTREES", "wt"), n), b, label, prompt, packs[n])
                for m in models for n, _r, b, _h in cases]
        for job in jobs:
            job.result()


main()
