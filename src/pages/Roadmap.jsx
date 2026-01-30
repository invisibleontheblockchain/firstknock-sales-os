import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, Shield, Smartphone, Map as MapIcon, Globe, WifiOff, FileText, Camera } from 'lucide-react';

export default function Roadmap() {
  const phases = [
    {
      title: "Phase 1: The Fortress (Sovereignty)",
      icon: <Shield className="w-6 h-6 text-yellow-500" />,
      items: [
        { label: "Implement 'The Bridge' Backup Function", desc: "Auto-export Neon data to JSON/Email daily (Sovereignty)", status: "pending" },
        { label: "Hardening RLS Policies", desc: "Strict separation of Rep vs Manager data access", status: "pending" }
      ]
    },
    {
      title: "Phase 2: The Sword (Mobile Core)",
      icon: <Smartphone className="w-6 h-6 text-blue-500" />,
      items: [
        { label: "Offline Mode Protocol", desc: "Implement localforage + TanStack Query persistence for field work", status: "pending" },
        { label: "Geolocation Parity", desc: "Verify native GPS permissions on iOS/Android devices", status: "pending" },
        { label: "Camera Integration", desc: "Test profile/property photo capture on device", status: "pending" }
      ]
    },
    {
      title: "Phase 3: The Map (Polish)",
      icon: <MapIcon className="w-6 h-6 text-green-500" />,
      items: [
        { label: "Route Stability Stress Test", desc: "Verify 500+ pin performance without lag", status: "pending" },
        { label: "Dark Room Haptics", desc: "Ensure vibration feedback works on mobile for interactions", status: "pending" }
      ]
    },
    {
      title: "Phase 4: The Gatekeepers (App Store)",
      icon: <Globe className="w-6 h-6 text-purple-500" />,
      items: [
        { label: "Delete Account Button", desc: "Mandatory requirement for Apple App Store", status: "pending" },
        { label: "EULA / Privacy Page", desc: "Required legal documentation accessible in-app", status: "pending" },
        { label: "App Assets", desc: "Generate adaptive icons and splash screens", status: "pending" }
      ]
    }
  ];

  return (
    <div className="h-full overflow-y-auto bg-black text-white p-6 md:p-12 pb-24">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-white">The Orchestrator's Audit</h1>
          <p className="text-gray-400">The strategic path to the finish line. 1+1=2.</p>
        </div>

        <div className="grid gap-6">
          {phases.map((phase, idx) => (
            <Card key={idx} className="border-l-4 border-l-yellow-500 bg-[#111] border-gray-800 text-white">
              <CardHeader className="flex flex-row items-center gap-4">
                <div className="p-2 bg-gray-900 rounded-lg border border-gray-700">
                  {phase.icon}
                </div>
                <div>
                  <CardTitle className="text-white">{phase.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {phase.items.map((item, i) => (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-lg hover:bg-white/5 transition-colors border border-transparent hover:border-gray-800">
                      {item.status === 'done' ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5" />
                      ) : (
                        <Circle className="w-5 h-5 text-gray-600 mt-0.5" />
                      )}
                      <div>
                        <div className="font-medium text-sm text-gray-200">{item.label}</div>
                        <p className="text-xs text-gray-500">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}