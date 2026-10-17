# Infinity Studio Matrix run - one of her graphs on our own ComfyUI (127.0.0.1, CPU, $0). Called by the studio node through
# /usr/local/bin/infinity-comfy:
#   infinity-comfy <graph.json> <out> [params.json|-] [in] [in2] [in3] ...
# graph.json is the row's workflow_json from control_store.comfyui_workflows (the API graph, or a row that holds one); nothing about a
# graph is typed here. params.json is {"<node id>.<input>": value} - the run's prompt, seed, steps ... laid over the stored graph.
# Each input file is copied into ComfyUI's input folder and given, in node-id order, to the Load* node of its kind (LoadImage gets the
# pictures, LoadVideo the films, LoadAudio the sounds) unless params already set it. The first file the graph saves is written to <out>.
import json, os, shutil, sys, time, urllib.error, urllib.parse, urllib.request, uuid

BASE = os.environ.get("COMFYUI_URL", "http://127.0.0.1:%s" % os.environ.get("COMFYUI_PORT", "8188"))
HOME = os.path.join(os.environ.get("MODELS_HOME", "/var/lib/memelli-chrome/models"), "comfyui")
IN_DIR = os.environ.get("COMFYUI_INPUT_DIR", os.path.join(HOME, "in"))  # the folder ComfyUI was started with (--input-directory)
WAIT = int(os.environ.get("COMFYUI_RUN_TIMEOUT_S", "3600"))
KIND = {"LoadImage": ("image", (".png", ".jpg", ".jpeg", ".webp", ".bmp")),
        "LoadVideo": ("file", (".mp4", ".webm", ".mov", ".mkv")),
        "LoadAudio": ("audio", (".wav", ".mp3", ".flac", ".ogg", ".m4a"))}


def call(path, body=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:  # ComfyUI names the bad node and input in the body (node_errors)
        print("ComfyUI %s %s: %s" % (path.split("?")[0], e.code, e.read().decode("utf-8", "replace")[:1200]), file=sys.stderr); sys.exit(1)


def api_graph(v):
    """the API graph is a map of node id -> {class_type, inputs}; a row may hold it under a key of its own"""
    if isinstance(v, str):
        v = json.loads(v)
    if isinstance(v, dict) and v and all(isinstance(n, dict) and "class_type" in n for n in v.values()):
        return v
    if isinstance(v, dict):
        for x in v.values():
            if isinstance(x, (dict, str)):
                try:
                    g = api_graph(x)
                except (ValueError, TypeError):
                    continue
                if g:
                    return g
    return None


def main():
    graph_file, out = sys.argv[1], sys.argv[2]
    params_file = sys.argv[3] if len(sys.argv) > 3 else "-"
    inputs = [f for f in sys.argv[4:] if os.path.isfile(f)]  # a slot the run did not fill ({in2}, {in3}) is skipped
    graph = api_graph(json.load(open(graph_file, encoding="utf-8")))
    if not graph:
        print("no ComfyUI API graph in " + graph_file, file=sys.stderr); sys.exit(2)
    params = json.load(open(params_file, encoding="utf-8")) if params_file not in ("-", "") and os.path.exists(params_file) else {}
    for k, val in params.items():
        nid, _, name = k.partition(".")
        if nid in graph and name:
            graph[nid].setdefault("inputs", {})[name] = val
    os.makedirs(IN_DIR, exist_ok=True)
    order = sorted(graph, key=lambda n: (len(n), n))
    for f in inputs:
        ext = os.path.splitext(f)[1].lower()
        for nid in order:
            cls = graph[nid].get("class_type")
            if cls in KIND and ext in KIND[cls][1]:
                field = KIND[cls][0]
                if ("%s.%s" % (nid, field)) in params or graph[nid].get("_given"):
                    continue
                name = "memelli-%s%s" % (uuid.uuid4().hex[:10], ext)
                shutil.copyfile(f, os.path.join(IN_DIR, name))
                graph[nid]["inputs"][field] = name
                graph[nid]["_given"] = True
                break
    for n in graph.values():
        n.pop("_given", None)
    t0 = time.time()
    pid = json.loads(call("/prompt", {"prompt": graph, "client_id": "memelli-studio-" + uuid.uuid4().hex[:8]}))["prompt_id"]
    while True:
        h = json.loads(call("/history/" + pid)).get(pid)
        if h:
            st = h.get("status", {})
            if st.get("status_str") == "error":
                msgs = [m for m in st.get("messages", []) if m and m[0] == "execution_error"]
                print("graph failed: " + json.dumps(msgs[-1][1] if msgs else st)[:800], file=sys.stderr); sys.exit(1)
            # only what the graph SAVED (type output): a Load* node also shows its own input file in the history
            files = [f for node in h.get("outputs", {}).values() for key in ("images", "gifs", "videos", "audio") for f in node.get(key, [])
                     if isinstance(f, dict) and f.get("filename") and f.get("type", "output") == "output"]
            if files:
                f = files[0]
                q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
                with open(out, "wb") as w:
                    w.write(call("/view?" + q))
                print("comfy", pid, f["filename"], round(time.time() - t0, 1), "s")
                return
            if st.get("completed"):
                print("graph finished with no saved file", file=sys.stderr); sys.exit(1)
        if time.time() - t0 > WAIT:
            print("graph still running after %ss (COMFYUI_RUN_TIMEOUT_S)" % WAIT, file=sys.stderr); sys.exit(1)
        time.sleep(2)


if __name__ == "__main__":
    main()
