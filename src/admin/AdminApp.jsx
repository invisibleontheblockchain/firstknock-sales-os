import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import AdminDashboard from '@/admin/AdminDashboard';

function LoadingScreen() {
  return (
    <div className="grid h-full place-items-center bg-[#030504] text-white">
      <div className="text-center">
        <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-white/10 border-t-[#39FF6E]" />
        <p className="mt-4 text-[10px] font-black uppercase tracking-[0.2em] text-white/35">Opening FirstKnock HQ</p>
      </div>
    </div>
  );
}
function SignInScreen() {
  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-[#030504] p-5 text-white">
      <div className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.022) 1px, transparent 1px)', backgroundSize: '42px 42px' }} />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#39FF6E]/10 blur-[110px]" />
      <div className="relative w-full max-w-md rounded-[30px] border border-white/[0.09] bg-[#080B09]/95 p-7 text-center shadow-[0_40px_120px_rgba(0,0,0,.65)] backdrop-blur-2xl sm:p-9">
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-[22px] border border-[#39FF6E]/20 bg-[#39FF6E]/10 shadow-[0_0_36px_rgba(57,255,110,.13)]">
          <LockKeyhole className="h-7 w-7 text-[#39FF6E]" />
        </span>
        <p className="mt-6 text-[10px] font-black uppercase tracking-[0.24em] text-[#7CFF9C]">Private command center</p>
        <h1 className="mt-3 text-4xl font-black tracking-[-0.055em]">FirstKnock HQ</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-white/42">Global field performance and live customer revenue intelligence for authorized operators.</p>
        <button
          onClick={() => base44.auth.redirectToLogin(window.location.href)}
          className="mt-7 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#39FF6E] px-5 text-xs font-black uppercase tracking-[0.15em] text-black shadow-[0_14px_40px_rgba(57,255,110,.16)] transition-transform hover:-translate-y-0.5"
        >
          <ShieldCheck className="h-4 w-4" /> Verify identity
        </button>
        <p className="mt-4 text-[10px] leading-relaxed text-white/25">Access is restricted after sign-in. The link alone does not grant access.</p>
      </div>
    </div>
  );
}

export default function AdminApp() {
  const { data: user, isLoading } = useQuery({
    queryKey: ['user'],
    queryFn: async () => {
      try {
        return await base44.auth.me();
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (isLoading) return <LoadingScreen />;
  if (!user) return <SignInScreen />;
  return <AdminDashboard />;
}
