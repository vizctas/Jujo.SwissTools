import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Jujo.SwissTools',
        short_name: 'SwissTools',
        description:
          'Navaja suiza de herramientas. Generador de QR con control de diseño real.',
        lang: 'es',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        // Un solo SVG escalable: evita generar y mantener cuatro PNG que dirían lo mismo.
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Las fuentes entran en el precaché: sin ellas, la app instalada y sin red
        // exportaría con una tipografía distinta a la de la vista previa.
        // Solo los subconjuntos latinos; cirílico y griego no los pide esta app.
        globPatterns: ['**/*.{js,css,html,svg}', '**/*latin*.woff2'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
});
