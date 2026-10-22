import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/zine.css';
import { App } from './App';
import { StoreProvider } from './store';
import { registerSW } from './swRegister';

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 挂载点');

registerSW();

createRoot(el).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
