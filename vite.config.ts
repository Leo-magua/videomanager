import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:5000'

  return {
    base: './',
    plugins: [inspectAttr(), react()],
    server: {
      proxy: {
        '/api': proxyTarget,
        '/upload': proxyTarget,
        '/register-local': proxyTarget,
        '/batch-clip': proxyTarget,
        '/stream-video': proxyTarget,
        '/download': proxyTarget,
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  }
})
