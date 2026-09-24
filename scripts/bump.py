#!/usr/bin/env python3
"""Bump the asset version: rewrites ?v= on css/app.js in index.html and regenerates the import map
so browsers fetch fresh copies of every module after a deploy. Usage: python scripts/bump.py [version]"""
import json, os, re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
idx = root / "index.html"; h = idx.read_text()
cur = int(re.search(r'js/app\.js\?v=(\d+)', h).group(1)); v = int(sys.argv[1]) if len(sys.argv) > 1 else cur + 1
files = sorted(str(p.relative_to(root)) for p in (root / "js").rglob("*.js"))
imap = json.dumps({"imports": {f"./{f}": f"./{f}?v={v}" for f in files}}).replace("\n", "")
h = re.sub(r'<script type="importmap">.*?</script>', '<script type="importmap">' + imap + '</script>', h, flags=re.S)
h = re.sub(r'css/app\.css\?v=\d+', f'css/app.css?v={v}', h); h = re.sub(r'js/app\.js\?v=\d+', f'js/app.js?v={v}', h)
idx.write_text(h); print(f"version {cur} -> {v}, {len(files)} modules in the import map")
