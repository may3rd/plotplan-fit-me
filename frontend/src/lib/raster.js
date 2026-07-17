// Rasterize the live plot SVG to a PNG/JPG blob, client-side, no dependency.
// ponytail: inherently DOM/Canvas/Image-dependent (getComputedStyle, Image,
// <canvas>) — there's no node-runnable check for this file the way view.js/
// geom.js get one; verified manually in the browser instead.

const STYLE_PROPS = [
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity',
  'fill-opacity', 'opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor',
]

// Serializing a cloned <svg> loses access to the page's external stylesheet
// (App.css) — the clone is rendered as a standalone document once it's
// inside an <img>. Copy the properties actually used by App.css's SVG rules
// onto each element's own `style` attribute so the export looks the same
// with no dependency on that stylesheet being reachable.
function inlineComputedStyle(srcEl, dstEl) {
  const cs = getComputedStyle(srcEl)
  let style = ''
  for (const prop of STYLE_PROPS) {
    const v = cs.getPropertyValue(prop)
    if (v) style += `${prop}:${v};`
  }
  if (style) dstEl.setAttribute('style', style)
  for (let i = 0; i < srcEl.children.length; i++) inlineComputedStyle(srcEl.children[i], dstEl.children[i])
}

/** Rasterize `svgEl` (the live, styled element) to a <canvas> at `scale`x
 * its current on-screen size, with a solid `bg` fill behind it (JPG has no
 * alpha channel, and a transparent PNG dragged into most tools looks better
 * with an explicit white backing anyway). */
export function rasterizeSvg(svgEl, { scale = 2, bg = '#ffffff' } = {}) {
  const rect = svgEl.getBoundingClientRect()
  const w = Math.round(rect.width * scale)
  const h = Math.round(rect.height * scale)

  const clone = svgEl.cloneNode(true)
  inlineComputedStyle(svgEl, clone)
  clone.setAttribute('width', w)
  clone.setAttribute('height', h)

  const xml = new XMLSerializer().serializeToString(clone)
  const svgUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(svgUrl)
      resolve(canvas)
    }
    img.onerror = () => { URL.revokeObjectURL(svgUrl); reject(new Error('SVG rasterization failed')) }
    img.src = svgUrl
  })
}

/** Rasterize and trigger a browser download in one step. `kind` is 'png' or 'jpg'. */
export async function downloadRaster(svgEl, kind, filename) {
  const canvas = await rasterizeSvg(svgEl)
  const mime = kind === 'jpg' ? 'image/jpeg' : 'image/png'
  const quality = kind === 'jpg' ? 0.92 : undefined
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality))
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
