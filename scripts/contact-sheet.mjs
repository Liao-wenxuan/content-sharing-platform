import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const DIR = new URL('../server/uploads/demo/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const files = readdirSync(DIR).filter((f) => f.endsWith('.jpg')).sort()

const imgs = files
  .map(
    (f) => `<figure>
      <img src="file:///${DIR.replace(/\\/g, '/')}${f}">
      <figcaption>${f.replace('.jpg', '')}</figcaption>
    </figure>`
  )
  .join('\n')

const html = `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;background:#111;font-family:system-ui;color:#fff}
  .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:10px}
  figure{margin:0}
  img{width:100%;height:230px;object-fit:cover;display:block;border-radius:4px}
  figcaption{font-size:15px;padding:4px 2px;color:#8f8;font-weight:700}
</style>
<div class="grid">${imgs}</div>`

writeFileSync(DIR + '_sheet.html', html)

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1500, height: 1100 } })
await p.goto('file:///' + DIR.replace(/\\/g, '/') + '_sheet.html')
await p.waitForTimeout(1200)
await p.screenshot({ path: 'shots/contact-sheet.png', fullPage: true })
await b.close()
console.log('联络表已生成，共', files.length, '张')
