import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../App';
import './index.css';

// Style 60 "Tactile Digital / Deformable UI" (issue #37) — reuses App/ItemList/etc. verbatim;
// see ./index.css for what actually makes this look and feel different from the main app.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
