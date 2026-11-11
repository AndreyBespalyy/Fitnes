import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

// Кабинет оператора платформы — отдельная страница со своим входом, в общий код рабочих экранов не попадает
const PlatformApp = lazy(() => import('./platform.tsx').then((m) => ({ default: m.PlatformApp })));
const isPlatform = location.pathname === '/platform' || location.pathname.startsWith('/platform/');

createRoot(document.getElementById('root')!).render(<StrictMode>{isPlatform ? <Suspense fallback={null}><PlatformApp /></Suspense> : <App />}</StrictMode>);
