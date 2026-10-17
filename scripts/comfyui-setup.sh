#!/bin/sh
# THE INFINITY STUDIO MATRIX WEIGHTS HOME - ComfyUI and its weights on the Playwright volume (Mel Briggs 2026-10-04: "the weights for comfy
# UI never made it to Playwright"; 10-08: "install it in LiveKit. Or Playwright ... open source models"; 2026-10-16: "help set up the
# ComfyUI sprites and Playwright"). Open source only: a weight whose licence is not on the open list is refused here, and the server runs
# with partner (paid) nodes off. Everything lands on the one persistent volume, $MODELS_HOME/comfyui (the root fs is gone on redeploy).
# Idempotent: a finished step is skipped, a cut download resumes, a run already going is left alone. Started at boot at the lowest
# priority on every boot (a finished step costs seconds; a changed list is picked up); it never blocks a walk.
#   ComfyUI       v0.38.0 (6b747c04, GPL-3.0, run as our service), its own uv Python 3.12 venv, CPU torch 2.14.0
#   the weights   comfyui-weights.tsv - the exact files the 8 graphs in control_store.comfyui_workflows load; $C/weights.tsv on the volume
#                 wins over the copy baked into the image, so the list changes without a redeploy
#   the nodes     comfyui-nodes.tsv - custom nodes, each pinned to a commit; all 8 graphs run on core nodes, so every row starts off
#   the map       extra_model_paths.yaml - the one file ComfyUI finds its weights through, written here every run
# THE FLOOR: the Chrome profiles live on this same volume. A weight that would leave less than COMFYUI_KEEP_FREE_GB (default 8) free is
# skipped and named in READY.json, never forced.
set -u
M="${MODELS_HOME:-/var/lib/memelli-chrome/models}"; C="$M/comfyui"; APP="${APP_DIR:-/app}"
COMFY_TAG=v0.38.0; COMFY_SHA=6b747c0428c343e1417219641db93a4fb7cb69ae; TORCH="torch==2.14.0 torchvision==0.29.0"
KEEP=$(( ${COMFYUI_KEEP_FREE_GB:-8} * 1073741824 ))
OPEN=" apache-2.0 mit bsd-3-clause bsd-2-clause "
TAB=$(printf '\t')
mkdir -p "$C" "$C/in" "$C/out" "$C/user" "$C/models" "$M/bin"
exec 9>"$C/.setup.lock"; flock -n 9 || { echo "setup already running"; exit 0; }
export HOME="$M" UV_INSTALL_DIR="$M/bin" UV_CACHE_DIR="$M/.uv-cache" UV_PYTHON_INSTALL_DIR="$M/.python" PATH="$M/bin:$PATH"
say() { echo "[$(date -u +%T)] $*"; }
free_b() { df -P -B1 "$M" | awk 'NR==2{print $4}'; }
size_of() { stat -c %s "$1" 2>/dev/null || echo 0; }
say "start"; df -h "$M" | tail -1

# 1. uv (shared with models-setup.sh) and ComfyUI at its tag
[ -x "$M/bin/uv" ] || { curl -LsSf https://astral.sh/uv/install.sh | sh || { say "FAIL uv"; exit 1; }; }
uv --version
[ -d "$C/ComfyUI/.git" ] || git clone -q --depth 1 --branch "$COMFY_TAG" https://github.com/comfyanonymous/ComfyUI.git "$C/ComfyUI" || { say "FAIL clone ComfyUI"; exit 1; }
HEAD=$(git -C "$C/ComfyUI" rev-parse HEAD)
[ "$HEAD" = "$COMFY_SHA" ] || { say "FAIL ComfyUI is at $HEAD, not $COMFY_TAG ($COMFY_SHA)"; exit 1; }
say "ComfyUI $COMFY_TAG $HEAD"

# 2. its own Python and CPU torch (no GPU on this box), then ComfyUI's requirements (torch is already there, so it stays the CPU build)
[ -x "$C/.venv/bin/python" ] || uv venv -q --python 3.12 "$C/.venv" || { say "FAIL venv"; exit 1; }
PY="$C/.venv/bin/python"
"$PY" -c "import torch" 2>/dev/null || { say "torch (cpu)"; uv pip install -q --python "$PY" $TORCH --index-url https://download.pytorch.org/whl/cpu || { say "FAIL torch"; exit 1; }; }
say "requirements"; uv pip install -q --python "$PY" -r "$C/ComfyUI/requirements.txt" || { say "FAIL requirements"; exit 1; }
"$PY" -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"

# 3. custom nodes, each at its pinned commit (on=1 rows only)
NODES="$C/nodes.tsv"; [ -f "$NODES" ] || NODES="$APP/scripts/comfyui-nodes.tsv"
NODES_ON=""
while IFS="$TAB" read -r on name url sha req licence note; do
  case "$on" in 1) ;; *) continue ;; esac
  case "$OPEN" in *" $licence "*) ;; *) say "REFUSED node $name: licence $licence"; continue ;; esac
  d="$C/ComfyUI/custom_nodes/$name"
  if [ "$(git -C "$d" rev-parse HEAD 2>/dev/null)" != "$sha" ]; then
    rm -rf "$d"; mkdir -p "$d"
    { git -C "$d" init -q && git -C "$d" remote add origin "$url" && git -C "$d" fetch -q --depth 1 origin "$sha" && git -C "$d" checkout -q FETCH_HEAD; } </dev/null || { say "FAIL node $name"; rm -rf "$d"; continue; }
  fi
  [ "$req" != "-" ] && [ -f "$d/$req" ] && { uv pip install -q --python "$PY" -r "$d/$req" </dev/null || say "FAIL node requirements $name"; }
  NODES_ON="$NODES_ON\"$name\","; say "node $name $sha"
done <<EOF
$(grep -v '^#' "$NODES" | grep -v '^[[:space:]]*$')
EOF

# 3b. the Memelli Playwright nodes (this service's own browser, step by step, as ComfyUI nodes) - always linked, from the image
[ -d "$APP/comfy_nodes/memelli_playwright" ] && ln -sfn "$APP/comfy_nodes/memelli_playwright" "$C/ComfyUI/custom_nodes/memelli_playwright" && NODES_ON="$NODES_ON\"memelli_playwright\"," && say "node memelli_playwright (Playwright's own verbs)"

# 4. the weights: the exact files the stored graphs load, into ComfyUI's own folder names
W="$C/weights.tsv"; [ -f "$W" ] || W="$APP/scripts/comfyui-weights.tsv"
HAVE=""; SKIPPED=""; REFUSED=""; FAILED=""
while IFS="$TAB" read -r on folder file url bytes licence graph note; do
  case "$on" in 1) ;; *) continue ;; esac
  f="$C/models/$folder/$file"; mkdir -p "$C/models/$folder"
  if [ "$(size_of "$f")" = "$bytes" ]; then HAVE="$HAVE{\"folder\":\"$folder\",\"file\":\"$file\",\"bytes\":$bytes,\"graph\":\"$graph\"},"; continue; fi
  case "$OPEN" in *" $licence "*) ;; *) say "REFUSED $file: licence $licence is not on the open list"; REFUSED="$REFUSED\"$file\","; continue ;; esac
  need=$(( bytes - $(size_of "$f.part") ))
  if [ $(( $(free_b) - need )) -lt "$KEEP" ]; then
    say "SKIPPED $file: $(( bytes / 1048576 )) MB would leave less than ${COMFYUI_KEEP_FREE_GB:-8} GB free"; SKIPPED="$SKIPPED\"$file\","; continue
  fi
  say "get $folder/$file ($(( bytes / 1048576 )) MB, $licence, for $graph)"
  if curl -L --fail --silent --show-error --retry 3 -C - -o "$f.part" "$url" </dev/null && [ "$(size_of "$f.part")" = "$bytes" ]; then
    mv "$f.part" "$f"; HAVE="$HAVE{\"folder\":\"$folder\",\"file\":\"$file\",\"bytes\":$bytes,\"graph\":\"$graph\"},"; say "got $file"
  else
    say "FAIL $file ($(size_of "$f.part") of $bytes bytes)"; FAILED="$FAILED\"$file\","
  fi
done <<EOF
$(grep -v '^#' "$W" | grep -v '^[[:space:]]*$')
EOF

# 5. the map: ComfyUI attaches to these weights through this one file
cat > "$C/extra_model_paths.yaml" <<EOF
# written by comfyui-setup.sh - the weights home on the Playwright volume
memelli:
  base_path: $C/models
  checkpoints: checkpoints
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  clip_vision: clip_vision
  vae: vae
  loras: loras
  audio_encoders: audio_encoders
  upscale_models: upscale_models
  frame_interpolation: frame_interpolation
  background_removal: background_removal
EOF

# 6. one load of ComfyUI with every node, then out (it must load clean before READY is written)
say "smoke"
( cd "$C/ComfyUI" && timeout 900 "$PY" main.py --cpu --quick-test-for-ci --disable-api-nodes --disable-auto-launch \
    --user-directory "$C/user" --extra-model-paths-config "$C/extra_model_paths.yaml" ) > "$C/smoke.log" 2>&1 || { say "FAIL smoke"; tail -20 "$C/smoke.log"; exit 1; }
grep -E "IMPORT FAILED|Traceback" "$C/smoke.log" && say "smoke has failures (above)"

du -sh "$C/models" "$C/.venv" 2>/dev/null
TV=$("$PY" -c "import torch; print(torch.__version__)")
printf '{"at":"%s","comfyui":"%s","commit":"%s","torch":"%s","device":"cpu","nodes":[%s],"weights":[%s],"skipped_floor":[%s],"refused":[%s],"failed":[%s],"free_gb":%s}\n' \
  "$(date -u +%FT%TZ)" "$COMFY_TAG" "$HEAD" "$TV" "${NODES_ON%,}" "${HAVE%,}" "${SKIPPED%,}" "${REFUSED%,}" "${FAILED%,}" "$(( $(free_b) / 1073741824 ))" > "$C/READY.json"
say "READY"; cat "$C/READY.json"
