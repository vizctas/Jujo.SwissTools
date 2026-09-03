import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/instrument-serif';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/apk.css';
import './styles/sniffer.css';
import './styles/bg.css';
import './styles/mesh.css';
import { App } from './App.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('Falta #root en index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
