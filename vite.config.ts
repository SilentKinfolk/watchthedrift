import { defineConfig } from 'vite'

// Project Pages live under https://silentkinfolk.github.io/watchthedrift/
// so every emitted asset URL must be prefixed with the repo name.
export default defineConfig({
  base: '/watchthedrift/',
})
