// Renders an SVG to a transparent PNG with Electron's Chromium (canvas, any size).
//   electron scripts/render-svg.cjs <input.svg> <output.png> [size]
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')

const [input, output, sizeArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const size = Number(sizeArg) || 1024

app.whenReady().then(async () => {
  const svg = readFileSync(input, 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `)
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const win = new BrowserWindow({ show: false })
  try {
    await win.loadURL('data:text/html,<!doctype html><title>render</title>')
    const png = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = ${size}
        canvas.height = ${size}
        canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size})
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = () => reject(new Error('the SVG could not be loaded'))
      img.src = ${JSON.stringify(src)}
    })`)
    writeFileSync(output, Buffer.from(png.split(',')[1], 'base64'))
    app.quit()
  } catch (err) {
    console.error(`render-svg: ${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
  }
})
