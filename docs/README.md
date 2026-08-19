# Homunculus Core documentation

A static documentation site, styled with the application's own **PRISM** theme
(tokens lifted from `[data-theme="prism"]` in `src/styles/global.css`).

## Hosting

Everything is plain HTML plus one stylesheet — no build step, no framework, no
JavaScript. Serve this directory with anything:

```bash
# Local preview
python -m http.server 8000 --directory docs
```

For GitHub Pages, point Pages at `/docs` on `main`. For Netlify, Cloudflare
Pages, or S3, publish this directory as-is. `index.html` is the entry point.

The only external request is a Google Fonts import in `prism.css` (Orbitron,
Share Tech Mono, Megrim). Self-host those files and rewrite the `@import` if you
need the site to work fully offline.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Landing page and card index |
| `prism.css` | The PRISM theme — all colour, type, and chrome |
| `_template.html` | Reference page skeleton (not linked from the site) |
| `_shell.sh` | Assembles a page from a body fragment: `./_shell.sh <slug> <Title> <Lede> < body.frag > slug.html` |

`_template.html` and `_shell.sh` are authoring aids. They are harmless if
published, but you can delete them from a deployment.

## Adding or editing a page

Every page carries the same sidebar, so the navigation lives in two places:
`_shell.sh` (for generated pages) and the `<nav class="sidebar">` block in each
HTML file. When adding a page, add its link to `_shell.sh`, regenerate the pages
you own, and add the link to any hand-written page's sidebar.

Structural check after editing:

```bash
cd docs && python - <<'PY'
import io, re, glob
from html.parser import HTMLParser
css = io.open('prism.css', encoding='utf-8').read()
assert css.count('{') == css.count('}'), 'unbalanced CSS'
defined = set(re.findall(r'\.([a-zA-Z][\w-]*)', css))
VOID = {'meta','link','br','hr','img','input','source'}
class P(HTMLParser):
    def __init__(s):
        super().__init__(); s.stack=[]; s.err=[]; s.classes=set()
    def handle_starttag(s,t,a):
        d=dict(a)
        if 'class' in d: s.classes.update(d['class'].split())
        if t not in VOID: s.stack.append(t)
    def handle_endtag(s,t):
        if t in VOID: return
        if s.stack and s.stack[-1]==t: s.stack.pop()
        else: s.err.append(t)
for f in sorted(glob.glob('*.html')):
    p=P(); p.feed(io.open(f, encoding='utf-8').read())
    if p.err or p.stack: print(f, p.err[:3], p.stack[:3])
    for c in p.classes - defined: print(f, 'undefined class:', c)
    for t in re.findall(r'href="([^"#:]+\.html)"', io.open(f, encoding='utf-8').read()):
        import os
        if not os.path.exists(t): print(f, '->', t, 'MISSING')
print('checked')
PY
```

## Contents

**Start here** — Overview, Getting Started, FAQ & Troubleshooting
**Using the bridge** — Widgets & Layout, Computer Core, and one page per tab
(BRIDGE, OSINT, HOME, DATA, ARCHIVE, CRYPTO)
**Deploy & operate** — Deployment, Configuration Reference, Security, Upgrading
**Development** — Architecture, WebSocket Protocol, Widget Development, Backend
Modules, Screener Engine, Contributing & Testing
