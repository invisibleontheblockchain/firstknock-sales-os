import React from "react";

const MAP_IMAGE = "https://media.base44.com/images/public/695eb764b077190880be21de/eca53f465_generated_image.png";

export default function CommandMapAuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div className="min-h-[100dvh] overflow-y-auto bg-black text-white md:grid md:grid-cols-[minmax(0,1.12fr)_minmax(460px,0.88fr)]">
      <section
        className="relative hidden min-h-[100dvh] overflow-hidden border-r border-primary/20 bg-cover bg-center md:flex md:items-center md:justify-center"
        style={{ backgroundImage: `linear-gradient(rgba(0,10,4,0.1),rgba(0,8,3,0.28)),url(${MAP_IMAGE})` }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-black/10 via-transparent to-black/45" />
        <div className="relative overflow-hidden rounded-2xl bg-black/90 px-7 py-4 shadow-[0_18px_70px_rgba(0,0,0,0.65)] backdrop-blur-sm">
          <img
            src="https://media.base44.com/images/public/695eb764b077190880be21de/3a5836111_firstknockmaintransparentlogo.png"
            alt="FirstKnock"
            className="h-auto w-[440px] max-w-[42vw] object-contain"
          />
        </div>
      </section>

      <section className="flex min-h-[100dvh] items-stretch justify-center bg-black p-3 sm:p-4">
        <div className="flex w-full max-w-[510px] flex-col rounded-2xl border border-primary bg-black shadow-[0_0_38px_rgba(46,235,87,0.12)]">
          <div className="border-b border-white/[0.04] bg-gradient-to-b from-[#031108] to-[#020a05] px-6 pb-8 pt-16 sm:px-8 lg:px-10 lg:pt-[28vh]">
            <Icon className="mb-5 h-10 w-10 text-primary" strokeWidth={1.8} aria-hidden="true" />
            <h1 className="font-heading text-4xl font-extrabold tracking-tight text-white">{title}</h1>
            {subtitle && <p className="mt-2 text-base text-white/55">{subtitle}</p>}
            <div className="mt-8">{children}</div>
          </div>
          {footer && <p className="mt-auto px-6 py-7 text-center text-sm text-white/65">{footer}</p>}
        </div>
      </section>
    </div>
  );
}