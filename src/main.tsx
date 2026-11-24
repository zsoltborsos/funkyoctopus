import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { container } from '@core/container/container.ts';
import { registerServices } from '@core/bootstrap.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { TRANSPORT } from '@core/transport/transport-client.ts';
import { ActiveChatScope } from '@features/chat/ActiveChatScope.tsx';
import { App } from './App.tsx';
import './index.css';

registerServices(container);
container.resolve(TRANSPORT).connect();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found');
}

createRoot(root).render(
  <StrictMode>
    <ContainerProvider container={container}>
      <ActiveChatScope>
        <ShellProvider>
          <App />
        </ShellProvider>
      </ActiveChatScope>
    </ContainerProvider>
  </StrictMode>,
);
