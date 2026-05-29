import React from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import { App } from './App';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

for (const node of Array.from(document.body.childNodes)) {
  if (node === rootElement || node.nodeName === 'SCRIPT') {
    continue;
  }
  document.body.removeChild(node);
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
