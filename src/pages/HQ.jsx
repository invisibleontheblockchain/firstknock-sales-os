import React, { useEffect } from 'react';

const PRIVATE_HQ_PATH = '/hq/index.html';

export default function HQRedirect() {
  useEffect(() => {
    window.location.replace(PRIVATE_HQ_PATH);
  }, []);

  return (
    <div className="grid h-full place-items-center bg-black px-6 text-center text-white">
      <div>
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-[#39FF6E]" />
        <p className="mt-4 text-xs font-black uppercase tracking-[0.18em] text-white/45">
          Opening private FirstKnock HQ
        </p>
        <a className="mt-3 inline-block text-xs font-bold text-[#39FF6E] underline" href={PRIVATE_HQ_PATH}>
          Continue to HQ
        </a>
      </div>
    </div>
  );
}
