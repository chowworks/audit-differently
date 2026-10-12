import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// The checked-in release notes (docs/release-notes) are published at /release-notes/, the way Learn
// Differently publishes its own. The page links its screenshots as ../screenshots/<feature>/<file>, so
// only those files are copied to dist/screenshots/. docs/ stays the single source; nothing is
// duplicated in the repo.
const docs = resolve(__dirname, '../../docs')
const notesPage = resolve(docs, 'release-notes/index.html')
// The privacy page (docs/privacy) is published the same way at /privacy/, so it opens before sign-in.
const privacyPage = resolve(docs, 'privacy/index.html')
// The terms (docs/terms) the same way, at /terms/.
const termsPage = resolve(docs, 'terms/index.html')
const shots = resolve(docs, 'screenshots')
const SHOTS = /\.\.\/screenshots\/[^"'\s)]+\.(?:png|jpe?g|webp|gif)/g

function publishReleaseNotes(): Plugin {
  return {
    name: 'publish-release-notes',
    apply: 'build',
    closeBundle() {
      const page = readFileSync(notesPage, 'utf8')
      const out = resolve(__dirname, 'dist')
      mkdirSync(resolve(out, 'release-notes'), { recursive: true })
      copyFileSync(notesPage, resolve(out, 'release-notes/index.html'))
      mkdirSync(resolve(out, 'privacy'), { recursive: true })
      copyFileSync(privacyPage, resolve(out, 'privacy/index.html'))
      mkdirSync(resolve(out, 'terms'), { recursive: true })
      copyFileSync(termsPage, resolve(out, 'terms/index.html'))
      for (const shot of page.match(SHOTS) ?? []) {
        const rel = shot.slice('../'.length)
        const from = resolve(docs, rel)
        if (!existsSync(from)) continue
        mkdirSync(dirname(resolve(out, rel)), { recursive: true })
        copyFileSync(from, resolve(out, rel))
      }
    },
  }
}

// The dev server serves the same page and screenshots, so the links in the footer work in the
// local demo too (without this, Vite's SPA fallback would answer with the app).
function serveReleaseNotes(): Plugin {
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  }
  return {
    name: 'serve-release-notes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let url: string
        try {
          url = decodeURIComponent((req.url ?? '').split('?')[0])
        } catch {
          return next()
        }
        if (url === '/release-notes' || url === '/privacy' || url === '/terms') {
          res.writeHead(302, { Location: `${url}/` })
          res.end()
          return
        }
        // Exactly the notes page, the privacy and terms pages and files inside docs/screenshots: nothing else under docs/ (docs/private
        // holds real documents on some machines) is reachable, however the path is spelled.
        let file: string | undefined
        if (url === '/release-notes/' || url === '/release-notes/index.html') file = notesPage
        else if (url === '/privacy/' || url === '/privacy/index.html') file = privacyPage
        else if (url === '/terms/' || url === '/terms/index.html') file = termsPage
        else if (url.startsWith('/screenshots/')) {
          const candidate = resolve(shots, `.${url.slice('/screenshots'.length)}`)
          if (candidate.startsWith(shots + sep)) file = candidate
        }
        if (!file || !existsSync(file)) return next()
        const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
        res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream' })
        res.end(readFileSync(file))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), publishReleaseNotes(), serveReleaseNotes()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
})
