import { createRoot } from 'react-dom/client';
import './index.css';
import App from './ui/App';
import { sim } from './ui/adapters';
import SceneView from './ui/scenes/SceneView';

const scene = new URLSearchParams(location.search).get('scene');

createRoot(document.getElementById('root')!).render(scene ? <SceneView simClient={sim} /> : <App />);
