import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const BRIDGE_PORT = Number(process.env.JUJO_BRIDGE_PORT) || 8787;

/**
 * Levanta el puente junto al servidor de desarrollo y sirve su token en el mismo
 * origen que la app.
 *
 * Una página web no puede arrancar un proceso local —esa puerta está cerrada por
 * diseño en el navegador— así que «el puente arranca con la app» se resuelve donde
 * sí se puede: quien sirve la app lo arranca. En desarrollo, este plugin. En
 * producción es al revés y más simple: el propio puente sirve la app compilada.
 *
 * Como el token lo genera este plugin, no hay que leerlo de la salida del proceso
 * ni pedírselo al usuario.
 */
function adbBridge(): Plugin {
  let child: ChildProcess | null = null;
  const token = randomBytes(16).toString('hex');

  return {
    name: 'jujo-adb-bridge',
    apply: 'serve',
    configureServer(server) {
      const origin = `http://localhost:${server.config.server.port ?? 5173}`;

      child = spawn(
        process.execPath,
        [
          'bridge/server.mjs',
          '--port', String(BRIDGE_PORT),
          '--token', token,
          '--origin', origin,
          '--origin', `http://127.0.0.1:${server.config.server.port ?? 5173}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );

      child.stdout?.on('data', (chunk) => {
        const text = String(chunk).trim();
        // Solo lo que aporta: el resto es la portada del puente, ya visible al
        // arrancarlo a mano.
        if (/adb |ffmpeg|memoria|capturas|ocupado|NO ENCONTRADO/.test(text)) {
          server.config.logger.info(`  ${text.replace(/\n\s*/g, '\n  ')}`);
        }
      });
      child.stderr?.on('data', (chunk) =>
        server.config.logger.error(`[puente] ${String(chunk).trim()}`),
      );
      child.on('error', (error) =>
        server.config.logger.error(`[puente] no se pudo arrancar: ${error.message}`),
      );

      // Mismo origen que la app: el navegador lo lee sin CORS ni token previo.
      server.middlewares.use('/__bridge.json', (_request, response) => {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.end(JSON.stringify({ port: BRIDGE_PORT, token, protocol: 1 }));
      });

      const stop = (): void => {
        child?.kill();
        child = null;
      };
      server.httpServer?.once('close', stop);
      process.once('exit', stop);
    },
  };
}

export default defineConfig({
  // El worker del recortador importa la librería de modelos de forma diferida, y eso
  // obliga a dividir el código. El formato `iife` que Vite usa por defecto para
  // workers no lo admite, así que se empaqueta como módulo ES.
  worker: { format: 'es' },
  plugins: [
    adbBridge(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Jujo.SwissTools',
        short_name: 'SwissTools',
        description: 'Navaja suiza de herramientas. QR, instalación de APK, captura de media y recorte de fondo.',
        lang: 'es',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}', '**/*latin*.woff2'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
});
