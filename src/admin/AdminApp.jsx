import React, { useEffect } from 'react';
import AdminDashboard from '@/admin/AdminDashboard';
import '@/admin/admin.css';

export default function AdminApp() {
  useEffect(() => {
    document.title = 'FirstKnock HQ';
  }, []);

  return <AdminDashboard />;
}
