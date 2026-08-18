import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        // The site itself.
        main: 'index.html',
        // The physics sandbox: same sim and renderer, driven by a synthetic
        // metronome instead of audio. Kept in the build so motion can be tuned
        // in isolation without loading or analysing a track.
        sandbox: 'sandbox.html',
      },
    },
  },
  server: {
    port: 5173,
    open: false,
  },
});
