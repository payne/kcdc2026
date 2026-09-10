import { defineConfig, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import fs from 'node:fs'
import path from 'node:path'

function directoryListing(): Plugin {
  return {
    name: 'directory-listing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
        const fsPath = path.join(server.config.root, urlPath)

        fs.stat(fsPath, (err, stats) => {
          if (err || !stats.isDirectory()) return next()
          if (fs.existsSync(path.join(fsPath, 'index.html'))) return next()

          fs.readdir(fsPath, { withFileTypes: true }, (err, entries) => {
            if (err) return next()

            const names = entries
              .map((e) => e.name + (e.isDirectory() ? '/' : ''))
              .sort()
            const rows = names
              .map((name) => `<li><a href="${path.posix.join(urlPath, name)}">${name}</a></li>`)
              .join('\n')
            const parentRow =
              urlPath !== '/'
                ? `<li><a href="${path.posix.join(urlPath, '..')}/">../</a></li>`
                : ''

            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(`<!doctype html>
<meta charset="utf-8">
<title>Index of ${urlPath}</title>
<h1>Index of ${urlPath}</h1>
<ul>
${parentRow}
${rows}
</ul>`)
          })
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [basicSsl(), directoryListing()],
})
