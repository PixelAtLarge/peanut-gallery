import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { PeanutGallery } from '@pixelatlarge/peanut-gallery-widget/react';
import App from './App.jsx';
import './styles/tokens.css';
import './styles/app.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
    {/* Shown only when the page is opened with ?peanut (then it stays on for the tab).
        With VITE_PEANUT_RELAY set, notes go through that relay, and reviewers see each other's. */}
    <PeanutGallery repo="PixelAtLarge/peanut-gallery-sandbox" activation="query" relayUrl={import.meta.env.VITE_PEANUT_RELAY || undefined} />
  </StrictMode>,
);
