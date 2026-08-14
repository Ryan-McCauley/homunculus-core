// Rasterises the brand SVGs into the PNG/ICO set Electron needs.
//
// Run with:  npm run icons
//
// Uses Electron itself as the renderer rather than pulling in sharp or
// librsvg — Electron is already a devDependency, and it is the same Blink
// that draws the SVG in the app, so what you get here is what the app shows.
//
// Which source is used depends on the size, matching the rule in the brand
// sheet: the ringed mark's hairlines dissolve below 64px, so anything at or
// under 48 is cut from the solid hand instead.

const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync, readFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = resolve(__dirname, '..')
const OUT = join(ROOT, 'build', 'icons')

const RINGED = join(ROOT, 'assets', 'brand', 'tile.svg')
const SOLID = join(ROOT, 'public', 'favicon.svg')

// 1024 is packaging-only: electron-builder wants a >=512px master to cut the
// .icns/.ico set from, and macOS retina asks for the full 1024.
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
/** Sizes packed into icon.ico. The ICO format tops out at 256. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const sourceFor = (size) => (size <= 48 ? SOLID : RINGED)

const PAGE = join(tmpdir(), 'homunculus-icon.html')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Load a local file and wait for the paint. We listen for did-finish-load
 *  rather than awaiting loadFile(): that promise rejects with a spurious
 *  ERR_FAILED whenever a previous load is still settling, which killed every
 *  render after the first. */
function load(win, file) {
  return new Promise((res, rej) => {
    win.webContents.once('did-finish-load', () => res())
    win.webContents.once('did-fail-load', (_e, code, desc) =>
      rej(new Error(`${desc} (${code})`))
    )
    win.loadFile(file).catch(() => {})
  })
}

/** Render one SVG at 2x and downsample, which gives cleaner edges on the
 *  hairline rings than letting Blink rasterise straight to the target. */
async function render(win, svg, size) {
  const px = Math.min(size * 2, 1024)
  writeFileSync(
    PAGE,
    `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:${px}px;height:${px}px}
  </style>${svg}`
  )

  win.setContentSize(px, px)
  await load(win, PAGE)
  // Offscreen windows paint asynchronously; give the compositor a frame.
  await sleep(200)

  let img = await win.webContents.capturePage()
  if (img.isEmpty()) throw new Error(`capturePage returned an empty image at ${size}px`)
  if (img.getSize().width !== size) {
    img = img.resize({ width: size, height: size, quality: 'best' })
  }
  return img.toPNG()
}

/** Build a Vista-style .ico: a directory of PNG-compressed entries.
 *  Hand-rolled because there is no dependency here that writes ICO, and the
 *  container is only a 6-byte header plus 16 bytes per image. */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length

  entries.forEach(({ size, png }, i) => {
    const at = i * 16
    // 256 is stored as 0 — the field is a single byte.
    dir.writeUInt8(size >= 256 ? 0 : size, at + 0) // width
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1) // height
    dir.writeUInt8(0, at + 2) // palette size
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // colour planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

app.whenReady().then(async () => {
  let win = null
  try {
    mkdirSync(OUT, { recursive: true })
    const svg = { [RINGED]: readFileSync(RINGED, 'utf8'), [SOLID]: readFileSync(SOLID, 'utf8') }

    win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true }
    })

    const made = []
    for (const size of SIZES) {
      const png = await render(win, svg[sourceFor(size)], size)
      writeFileSync(join(OUT, `${size}x${size}.png`), png)
      made.push({ size, png })
      const src = sourceFor(size) === SOLID ? 'solid' : 'ringed'
      console.log(`  ${String(size).padStart(3)}px  ${String(png.length).padStart(6)} B  ${src}`)
    }

    // icon.png is what BrowserWindow loads; 256 is the largest size Windows
    // and Linux actually ask for in a window/taskbar context.
    writeFileSync(join(OUT, 'icon.png'), made.find((m) => m.size === 256).png)

    const ico = buildIco(made.filter((m) => ICO_SIZES.includes(m.size)))
    writeFileSync(join(OUT, 'icon.ico'), ico)
    console.log(`  icon.ico  ${ico.length} B  (${ICO_SIZES.length} entries)`)

    console.log(`\nWrote ${SIZES.length + 2} files to build/icons/`)
    win.destroy()
    rmSync(PAGE, { force: true })
    app.exit(0)
  } catch (err) {
    console.error('icon generation failed:', err)
    if (win) win.destroy()
    rmSync(PAGE, { force: true })
    app.exit(1)
  }
})
