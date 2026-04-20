import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

console.info('[Mako IQ sidepanel] Side panel page starting up.', {
  url: window.location.href
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
