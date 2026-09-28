import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

/** Dev only: serve locally generated artifacts (../out) at /data, mirroring cdn.shadster.dev/f1-sim. */
function localData(): Plugin {
  const root = path.resolve(__dirname, '../out')
  return {
    name: 'f1sim-local-data',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const p = path.join(root, decodeURIComponent((req.url || '').split('?')[0]))
        if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return next()
        const buf = fs.readFileSync(p)
        const gz = buf[0] === 0x1f && buf[1] === 0x8b
        if (gz) res.setHeader('Content-Encoding', 'gzip')
        res.setHeader('Content-Type', p.endsWith('.json') ? 'application/json' : p.endsWith('.png') ? 'image/png' : 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(buf)
      })
    },
  }
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.F1SIM_BASE ?? '/') : '/',
  plugins: [react(), localData()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  build: {
    target: 'es2022',
    assetsDir: '_app',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    rollupOptions: { output: { manualChunks: { three: ['three'], r3f: ['@react-three/fiber', '@react-three/drei', '@react-three/postprocessing', 'postprocessing'] } } },
  },
}))
