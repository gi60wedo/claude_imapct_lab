import { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './ui/App';
import { sim } from './ui/adapters';
import SceneView from './ui/scenes/SceneView';

const params = new URLSearchParams(location.search);
const scene = params.get('scene');
const Dashboard = lazy(() => import('./ui/dash/Dashboard'));

createRoot(document.getElementById('root')!).render(
  scene ? <SceneView simClient={sim} />
    : params.get('view') === 'three' ? <Suspense fallback={null}><Dashboard /></Suspense>
      : <App />,
);
