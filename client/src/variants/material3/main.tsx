import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../App';
import './index.css';

// Style 76 "Material 3 Expressive (Mobile)" (issue #37) — reuses App/ItemList/etc. verbatim;
// see ./index.css for what actually makes this look different from the main app.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
