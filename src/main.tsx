import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { LayoutProvider } from './lib/layout.ts';
import './index.css';

createRoot(document.getElementById('root')!).render(<LayoutProvider><App /></LayoutProvider>);
