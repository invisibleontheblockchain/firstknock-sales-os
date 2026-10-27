import React from 'react';
import { X } from 'lucide-react';

/** The X that closes a top-of-app field notice. */
export default function FieldBannerClose({ label, onClose }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      title={label}
      className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-400 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#39FF4A]"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
