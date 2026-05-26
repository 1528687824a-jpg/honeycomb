$ErrorActionPreference = "Stop"

$distro = $env:OPENCLAW_WSL_DISTRO
if (-not $distro) {
  $distro = "Ubuntu-24.04"
}

$bash = @'
set -euo pipefail

OPENCLAW_ROOT="${OPENCLAW_ROOT:-/home/administrator/.npm-global/lib/node_modules/openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/home/administrator/.openclaw/openclaw.json}"
VIDEO_TIMEOUT_MS="${OPENCLAW_VIDEO_TIMEOUT_MS:-600000}"

if [ ! -d "$OPENCLAW_ROOT/dist" ]; then
  echo "OpenClaw dist directory not found: $OPENCLAW_ROOT/dist" >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "OpenClaw config not found: $CONFIG_PATH" >&2
  exit 1
fi

stamp="$(date +%Y%m%d%H%M%S)"

byteplus_provider="$(find "$OPENCLAW_ROOT/dist" -type f -name 'video-generation-provider-*.js' -print0 |
  xargs -0 grep -l 'BytePlus video generation' 2>/dev/null |
  head -n 1 || true)"

if [ -z "$byteplus_provider" ]; then
  echo "BytePlus video provider file not found" >&2
  exit 1
fi

cp "$byteplus_provider" "$byteplus_provider.bak-ark-media-$stamp"
python3 - "$byteplus_provider" "$VIDEO_TIMEOUT_MS" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
timeout_ms = int(sys.argv[2])
text = path.read_text(encoding="utf-8")
updated = re.sub(
    r"const DEFAULT_TIMEOUT_MS = \d+(?:e\d+)?;",
    f"const DEFAULT_TIMEOUT_MS = {timeout_ms};",
    text,
    count=1,
)
if updated == text:
    raise SystemExit("BytePlus DEFAULT_TIMEOUT_MS snippet not found")
path.write_text(updated, encoding="utf-8")
print(f"patched_byteplus_video_timeout_ms={timeout_ms}")
PY

openai_image_provider="$(find "$OPENCLAW_ROOT/dist" -type f -name 'image-generation-provider-*.js' -print0 |
  xargs -0 grep -l 'OpenAI image generation failed' 2>/dev/null |
  head -n 1 || true)"

if [ -z "$openai_image_provider" ]; then
  echo "OpenAI image provider file not found" >&2
  exit 1
fi

cp "$openai_image_provider" "$openai_image_provider.bak-ark-media-$stamp"
python3 - "$openai_image_provider" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = 'if (!isAzure) body.model = model;\n\t\t\t\tappendOpenAIImageOptions(body, req);'
patch = 'if (!isAzure) body.model = model;\n\t\t\t\tif (!isAzure && /(?:volces|bytepluses)\\.com/i.test(baseUrl)) body.response_format = "b64_json";\n\t\t\t\tappendOpenAIImageOptions(body, req);'

if 'body.response_format = "b64_json"' in text:
    print("patched_openai_image_provider_ark_b64=already-present")
else:
    if needle not in text:
        raise SystemExit("OpenAI image request snippet not found")
    text = text.replace(needle, patch, 1)
    path.write_text(text, encoding="utf-8")
    print("patched_openai_image_provider_ark_b64=true")
PY

cp "$CONFIG_PATH" "$CONFIG_PATH.bak-ark-media-$stamp"
python3 - "$CONFIG_PATH" "$VIDEO_TIMEOUT_MS" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
timeout_ms = int(sys.argv[2])
cfg = json.loads(path.read_text(encoding="utf-8"))
defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})
defaults["videoGenerationModel"] = {
    "primary": "byteplus/doubao-seedance-2-0-260128",
    "fallbacks": [
        "byteplus/doubao-seedance-2-0-fast-260128",
        "byteplus/seedance-1-5-pro-251215",
        "byteplus/seedance-1-0-pro-250528",
        "byteplus/seedance-1-0-lite-t2v-250428",
    ],
    "timeoutMs": timeout_ms,
}
defaults["imageGenerationModel"] = {
    "primary": "openai/doubao-seedream-5-0-260128",
    "timeoutMs": timeout_ms,
}
path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("updated_openclaw_media_defaults=true")
PY

/home/administrator/.npm-global/bin/openclaw config validate
systemctl --user restart openclaw-gateway.service
sleep 8
systemctl --user is-active openclaw-gateway.service
'@

$bash | wsl -d $distro -- bash -lc "tr -d '\r' | bash"
