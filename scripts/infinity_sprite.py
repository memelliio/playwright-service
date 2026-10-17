# Infinity Sprite Cut - the sprites formula, step 3, on our own CPU ($0). "WE HAVE THE SPRITES FORMULA" (Mel Briggs; MICROSOFT-WALL.md
# 28-44): videos in -> frame by frame -> the cut-out person is the sprite, ONE POSITION PER FRAME -> re-rendered later. Called by the
# studio node through /usr/local/bin/infinity-sprite:
#   infinity-sprite <in video|picture> <out sheet.png> [--fps 4] [--max-frames 48] [--model u2net_human_seg] [--cell 256]
#                   [--meta sprites.json] [--frames-dir dir]
# The cut is rembg (MIT) with u2net_human_seg (Apache-2.0) on onnxruntime CPU, baked into the image (REMBG_HOME), so a node never
# downloads mid-job. Out: one sheet (every frame's cut-out in a grid of equal cells, feet on the cell floor), and the meta JSON - for each
# frame its time, its box in the source frame (pixels and 0..1), its cell, fill and cover, and empty=true when nothing was cut.
# The cut finds the main figure, not proof of a person: a test pattern still cuts a shape (cover near 1.0) - read fill and cover.
import argparse, glob, json, math, os, shutil, subprocess, sys, tempfile, time
from PIL import Image
from rembg import new_session, remove

LICENCE = {"u2net_human_seg": "Apache-2.0", "u2net": "Apache-2.0", "isnet-general-use": "Apache-2.0", "birefnet-portrait": "MIT", "birefnet-general": "MIT"}


def frames_of(src, fps, max_frames, work):
    try:
        with Image.open(src) as im:
            im.load()
            return [im.convert("RGB")], 0.0
    except Exception:
        pass
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vf", "fps=%s" % fps, "-frames:v", str(max_frames),
                    os.path.join(work, "f%05d.png")], check=True)
    paths = sorted(glob.glob(os.path.join(work, "f*.png")))
    return [Image.open(p).convert("RGB") for p in paths], 1.0 / float(fps)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--fps", type=float, default=4); ap.add_argument("--max-frames", type=int, default=48)
    ap.add_argument("--model", default="u2net_human_seg"); ap.add_argument("--cell", type=int, default=256)
    ap.add_argument("--alpha", type=int, default=24, help="a pixel belongs to the sprite above this alpha")
    ap.add_argument("--meta"); ap.add_argument("--frames-dir")
    a = ap.parse_args()
    if a.model not in LICENCE:
        print("model %s is not on the open list: %s" % (a.model, ", ".join(LICENCE)), file=sys.stderr); sys.exit(2)
    t0 = time.time()
    work = tempfile.mkdtemp(prefix="sprite-")
    frames, step = frames_of(a.src, a.fps, a.max_frames, work)
    if not frames:
        print("no frames in " + a.src, file=sys.stderr); sys.exit(1)
    sess = new_session(a.model)
    if a.frames_dir:
        os.makedirs(a.frames_dir, exist_ok=True)
    cols = max(1, math.ceil(math.sqrt(len(frames)))); rows = math.ceil(len(frames) / cols)
    sheet = Image.new("RGBA", (cols * a.cell, rows * a.cell), (0, 0, 0, 0))
    out = []
    for i, fr in enumerate(frames):
        W, H = fr.size
        cut = remove(fr, session=sess)
        box = cut.getchannel("A").point(lambda v: 255 if v > a.alpha else 0).getbbox()
        col, row = i % cols, i // cols
        rec = {"i": i, "t": round(i * step, 3), "frame_w": W, "frame_h": H, "cell": [col, row]}
        if not box:
            rec["empty"] = True; out.append(rec); continue
        x0, y0, x1, y1 = box
        spr = cut.crop(box)
        # two plain measures for the learning layer: how much of the box is sprite, how much of the frame the box covers
        # (a test pattern or a busy scene comes back as a box over most of the frame; a person rarely does)
        solid = sum(spr.getchannel("A").point(lambda v: 1 if v > a.alpha else 0).getdata())
        rec.update({"fill": round(solid / float((x1 - x0) * (y1 - y0)), 4), "cover": round((x1 - x0) * (y1 - y0) / float(W * H), 4)})
        if a.frames_dir:
            spr.save(os.path.join(a.frames_dir, "%05d.png" % i))
        s = min(a.cell / spr.width, a.cell / spr.height)
        fit = spr.resize((max(1, round(spr.width * s)), max(1, round(spr.height * s))), Image.LANCZOS)
        sheet.alpha_composite(fit, (col * a.cell + (a.cell - fit.width) // 2, row * a.cell + a.cell - fit.height))
        rec.update({"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2,
                    "nx": round(x0 / W, 5), "ny": round(y0 / H, 5), "nw": round((x1 - x0) / W, 5), "nh": round((y1 - y0) / H, 5), "scale": round(s, 5)})
        out.append(rec)
    sheet.save(a.out)
    meta = {"kind": "sprite_sheet", "formula_step": 3, "source": os.path.basename(a.src), "fps": a.fps if step else None, "frames": len(frames),
            "with_person": sum(1 for r in out if not r.get("empty")), "cell": a.cell, "cols": cols, "rows": rows, "model": a.model,
            "model_licence": LICENCE[a.model], "tool": "rembg", "ms": round((time.time() - t0) * 1000), "positions": out}
    if a.meta:
        with open(a.meta, "w", encoding="utf-8") as w:
            json.dump(meta, w)
    shutil.rmtree(work, ignore_errors=True)
    print("sprite", a.out, len(frames), "frames", meta["with_person"], "with a person", round(time.time() - t0, 1), "s")


if __name__ == "__main__":
    main()
