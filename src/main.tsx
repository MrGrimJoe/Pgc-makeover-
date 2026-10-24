import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { LayoutProvider } from './lib/layout.ts';
import { registerServiceWorker, startInstallCapture } from './lib/pwa.ts';
import './index.css';

startInstallCapture();
registerServiceWorker();

createRoot(document.getElementById('root')!).render(<LayoutProvider><App /></LayoutProvider>);
