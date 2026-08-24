import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../App';
import './index.css';

// Style 71 "Modern Dark (Cinema Mobile)" (issue #37) — reuses App/ItemList/etc. verbatim;
// see ./index.css for what actually makes this look different from the main app.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
