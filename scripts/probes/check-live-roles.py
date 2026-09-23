"""Live confirmation of the review-round behaviours on 11435.

Prints the actual error body for image parts on non-user roles, and compares
image vs text-only prompt_tokens so the image provably reaches the model.

Usage: python check_live.py
"""
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:11435/v1"
KEY = "da6f9bd0acef6fd1ced3ea08cac8b2ad9f6b7081ed65b1cb"
TINY = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
        "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
MODEL = "deepseek/deepseek-v4.1-flash"


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
