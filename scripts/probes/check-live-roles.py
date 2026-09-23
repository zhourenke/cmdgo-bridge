"""Live confirmation of the review-round behaviours on 11435.

Prints the actual error body for image parts on non-user roles, and compares
image vs text-only prompt_tokens so the image provably reaches the model.

⚠️ 本探针会向真实上游发起 6 次对话请求，**消耗真实额度**，且其中一次带图片。
   请先确认桥已在运行，并显式同意后再执行。

用法:
    # Windows PowerShell
    $env:CMDGO_ALLOW_LIVE_PROBES = "1"
    $env:CMDGO_KEY = "<控制台 CONFIG 区的客户端 API key>"
    python check-live-roles.py

可用环境变量:
    CMDGO_ALLOW_LIVE_PROBES  必须为 1，否则本脚本拒绝运行（防误触）
    CMDGO_KEY                客户端 API key（必需，无默认值）
    CMDGO_BASE               桥的 /v1 地址，默认 http://127.0.0.1:11435/v1
    CMDGO_MODEL              模型 id，默认 deepseek/deepseek-v4.1-flash
"""
import json
import os
import sys
import urllib.error
import urllib.request

if os.environ.get("CMDGO_ALLOW_LIVE_PROBES") != "1":
    sys.exit(
        "拒绝运行：本探针会消耗真实上游额度。\n"
        "确认后请设置 CMDGO_ALLOW_LIVE_PROBES=1 再执行。"
    )

BASE = os.environ.get("CMDGO_BASE", "http://127.0.0.1:11435/v1")
KEY = os.environ.get("CMDGO_KEY", "")
if not KEY:
    sys.exit(
        "缺少 CMDGO_KEY：请填控制台 CONFIG 区的客户端 API key。\n"
        "本脚本不提供默认值——历史上这里硬编码过一个真实 key（F-01）。"
    )
TINY = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
        "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
MODEL = os.environ.get("CMDGO_MODEL", "deepseek/deepseek-v4.1-flash")


def call(messages, max_tokens=16):
    body = json.dumps({"model": MODEL, "messages": messages, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            payload = json.loads(r.read().decode("utf-8", "replace"))
            return r.status, payload
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:200]}


image_part = {"type": "image_url", "image_url": {"url": "data:image/png;base64," + TINY}}
text_part = {"type": "text", "text": "x"}

print("=== image parts on non-user roles (expect 400 + readable reason) ===")
for label, messages in [
    ("assistant", [{"role": "assistant", "content": [text_part, image_part]}]),
    ("system", [{"role": "system", "content": [text_part, image_part]}]),
    ("developer", [{"role": "developer", "content": [text_part, image_part]}]),
    ("tool", [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "ls", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": [image_part]},
    ]),
]:
    status, payload = call(messages)
    msg = payload.get("error", {}).get("message", payload)
    print(f"  [{label:9}] http={status}  {msg}")

print("\n=== prompt_tokens: image must cost more than text-only ===")
_, with_image = call([{"role": "user", "content": [text_part, image_part]}])
_, text_only = call([{"role": "user", "content": "x"}])
u1 = with_image.get("usage", {})
u2 = text_only.get("usage", {})
print(f"  with image : prompt_tokens={u1.get('prompt_tokens')} cached={u1.get('prompt_tokens_details', {}).get('cached_tokens')}")
print(f"  text only  : prompt_tokens={u2.get('prompt_tokens')} cached={u2.get('prompt_tokens_details', {}).get('cached_tokens')}")
delta = (u1.get("prompt_tokens") or 0) - (u2.get("prompt_tokens") or 0)
print(f"  delta      : {delta:+d}  -> {'image was billed, i.e. it reached the model' if delta > 0 else 'IMAGE NOT BILLED'}")
