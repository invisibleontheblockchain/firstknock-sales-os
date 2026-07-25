import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import AdminApp from '@/admin/AdminApp';
import '@/index.css';
import '@/admin/admin.css';

document.title = 'FirstKnock HQ';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClientInstance}>
      <AdminApp />
    </QueryClientProvider>
  </React.StrictMode>,
);

