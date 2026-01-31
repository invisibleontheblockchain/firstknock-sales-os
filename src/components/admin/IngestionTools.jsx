import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Check, Copy, Terminal, Database, Trash2, RefreshCw, HardDrive } from "lucide-react";
import { toast } from "sonner";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { base44 } from '@/api/base44Client';
import { Loader2 } from 'lucide-react';

export default function IngestionTools() {
    const [copied, setCopied] = useState(null);
    const [testing, setTesting] = useState(false);
    const [dbStats, setDbStats] = useState(null);
    const [loadingStats, setLoadingStats] = useState(false);
    const [targetZip, setTargetZip] = useState("");

    const fetchStats = async () => {
        setLoadingStats(true);
        try {
            const res = await base44.functions.invoke('cleanupDatabase', {}, 'POST');
            setDbStats(res.data);
        } catch (e) {
            console.error("Failed to fetch DB stats", e);
        } finally {
            setLoadingStats(false);
        }
    };

    useEffect(() => {
        fetchStats();
    }, []);

    const handleCleanup = async (type, value) => {
        const toastId = toast.loading("Deleting records...");
        try {
            const payload = { action: 'cleanup' };
            if (type === 'zip') payload.zip_code = value;
            if (type === 'state') payload.state = value;
            
            const res = await base44.functions.invoke('cleanupDatabase', payload, 'POST');
            toast.success(`Deleted ${res.data.deleted.toLocaleString()} records`, { id: toastId });
            fetchStats();
        } catch (e) {
            toast.error("Cleanup failed", { id: toastId });
        }
    };

    const copyToClipboard = (text, id) => {
        navigator.clipboard.writeText(text);
        setCopied(id);
        toast.success("Copied to clipboard");
        setTimeout(() => setCopied(null), 2000);
    };

    const testConnection = async () => {
        setTesting(true);
        try {
            // We use the SDK to call the function, which handles the auth cookie for admin session
            const res = await base44.functions.invoke('ingestProperties', {}, 'GET');
            const data = res.data;
            
            if (data.status === 'online') {
                toast.success(`Connected! Table exists. Row count: ${data.details.count}`);
            } else if (data.status === 'connected_no_table') {
                toast.warning("Connected to Neon, but table 'properties' is missing. Run the SQL Schema below!");
            } else {
                toast.error(`Connection Error: ${data.message}`);
            }
        } catch (e) {
            toast.error("Failed to connect. Check DATABASE_URL secret.");
            console.error(e);
        } finally {
            setTesting(false);
        }
    };

    const SQL_SCHEMA = `-- 1. Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Create Warehouse Table
CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY, -- SHA256(address|city|zip)
    address TEXT NOT NULL,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    location GEOMETRY(POINT, 4326),
    
    -- Intel
    smart_score INTEGER DEFAULT 0,
    turnover_prob FLOAT DEFAULT 0,
    equity NUMERIC,
    
    -- Details
    beds INTEGER,
    baths FLOAT,
    sqft INTEGER,
    year_built INTEGER,
    price NUMERIC,
    sold_date DATE,
    owner_name TEXT,
    property_type TEXT,
    mls_id TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_props_location ON properties USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_props_zip ON properties(zip_code);
CREATE INDEX IF NOT EXISTS idx_props_score ON properties(smart_score DESC);`;

    const CLIENT_SCRIPT = `/**
 * FIRSTKNOCK INGESTION AGENT
 * Automates data pipeline securely using your credentials.
 * 
 * SETUP:
 * 1. npm install axios csv-parser
 * 2. export PIPELINE_SECRET="your-secret-here" (or hardcode below)
 * 3. node ingest.js <path_to_csv>
 */
const fs = require('fs');
const axios = require('axios');
const csv = require('csv-parser');

const API_URL = process.env.API_URL || '${window.location.origin}/functions/ingestProperties';
// Security: Prefer Environment Variable, fallback to manual entry
const SECRET_KEY = process.env.PIPELINE_SECRET || 'YOUR_PIPELINE_SECRET'; 

// --- 🔧 FILTERS (Edit these to save space!) ---
const FILTER_ZIPS = [];    // Example: ['75001', '75002'] - Leave empty to import ALL
const STATE_FILTER = '';   // Example: 'TX' - Leave empty for all states
const MIN_SCORE = 0;       // Example: 50 - Only import high quality leads

async function run() {
    const file = process.argv[2];
    if(!file) {
        console.log('❌ Usage: node ingest.js <file.csv>');
        return;
    }

    if (API_URL.includes('localhost')) {
        console.warn('\\n⚠️  WARNING: API_URL is targeting localhost. For Base44, you should target the cloud URL.');
        console.warn('   If this fails, set API_URL environment variable to your deployed app URL.');
        console.warn('   Example: export API_URL="https://your-app.base44.app/functions/ingestProperties"\\n');
    }
    
    console.log(\`🤖 FirstKnock Agent Initialized\`);
    console.log(\`🎯 Target: \${API_URL}\`);
    console.log(\`📂 Reading \${file}...\`);
    
    const rows = [];
    fs.createReadStream(file)
        .pipe(csv())
        .on('data', d => {
            // Intelligent Mapping (Add more aliases as needed)
            const mapped = {
                address: d.Address || d.address || d.PROPERTY_ADDRESS,
                city: d.City || d.city || d.CITY,
                state: d.State || d.state || d.STATE,
                zip_code: d.Zip || d.zip || d.ZIP || d.ZipCode,
                lat: d.Lat || d.lat || d.LATITUDE,
                lng: d.Lng || d.lng || d.LONGITUDE,
                price: d.Price || d.price || d.SALE_PRICE,
                smart_score: d.Score || d.score || d.SMART_SCORE || 0,
                // Extra fields
                beds: d.Beds || d.BEDS,
                baths: d.Baths || d.BATHS,
                sqft: d.Sqft || d.SQFT,
                year_built: d.YearBuilt || d.YEAR_BUILT
            };
            // --- 🛡️ FILTER LOGIC ---
            if (FILTER_ZIPS.length > 0 && !FILTER_ZIPS.includes(mapped.zip_code)) return;
            if (STATE_FILTER && mapped.state !== STATE_FILTER) return;
            if (mapped.smart_score < MIN_SCORE) return;

            if(mapped.address && mapped.lat) rows.push(mapped);
        })
        .on('end', () => upload(rows));
}

async function upload(data) {
    const BATCH = 100; // Increased batch size
    const totalBatches = Math.ceil(data.length / BATCH);
    
    console.log(\`🚀 Starting upload of \${data.length} records in \${totalBatches} batches...\`);
    console.log(\`🔒 Using Secure Pipeline Secret: \${SECRET_KEY.slice(0,4)}***\`);

    let successTotal = 0;
    const startTime = Date.now();

    for(let i=0; i<data.length; i+=BATCH) {
        const batchNum = Math.floor(i/BATCH) + 1;
        const chunk = data.slice(i, i+BATCH);
        
        try {
            const res = await axios.post(API_URL, { 
                properties: chunk,
                source: 'AGENT_SCRIPT_V1' 
            }, {
                headers: { 'x-pipeline-secret': SECRET_KEY }
            });
            
            if(res.data.success) {
                successTotal += res.data.summary.inserted;
                const progress = Math.round((batchNum / totalBatches) * 100);
                process.stdout.write(\`\\r✅ Progress: \${progress}% | Batch \${batchNum}/\${totalBatches} | \${successTotal} Records Saved \`);
            }
        } catch (err) {
            console.error(\`\\n❌ Batch \${batchNum} Failed: \${err.message}\`);
            // Simple retry logic
            await new Promise(r => setTimeout(r, 1000));
        }
        // Rate limit protection
        await new Promise(r => setTimeout(r, 50));
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(\`\\n\\n🏁 MISSION COMPLETE\`);
    console.log(\`⏱️  Time: \${duration}s\`);
    console.log(\`📦 Total Records Ingested: \${successTotal}\`);
}

run();`;

    return (
        <div className="space-y-6">
            <div className="flex gap-4">
                <Button 
                    onClick={testConnection} 
                    disabled={testing}
                    className={`flex-1 font-bold ${testing ? 'bg-gray-800' : 'bg-green-600 hover:bg-green-700'}`}
                >
                    {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                    {testing ? "Testing Connection..." : "Test Neon Connection"}
                </Button>
            </div>

            <div className="p-4 rounded-xl bg-[#0A0A0A] border border-[#222]">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Database className="w-4 h-4 text-blue-500" />
                        <h3 className="text-sm font-bold text-white">1. Warehouse Schema</h3>
                    </div>
                    <Button 
                        size="sm" 
                        variant="outline" 
                        className="h-7 text-xs border-gray-700 hover:bg-gray-800"
                        onClick={() => copyToClipboard(SQL_SCHEMA, 'sql')}
                    >
                        {copied === 'sql' ? <Check className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
                        {copied === 'sql' ? 'Copied' : 'Copy SQL'}
                    </Button>
                </div>
                <p className="text-xs text-gray-500 mb-3">
                    Run this SQL in your Neon Console to create the optimized table structure.
                </p>
                <div className="bg-[#111] p-3 rounded-lg border border-[#222] overflow-x-auto">
                    <pre className="text-[10px] text-gray-300 font-mono">{SQL_SCHEMA}</pre>
                </div>
            </div>

            <div className="p-4 rounded-xl bg-[#0A0A0A] border border-[#222]">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Terminal className="w-4 h-4 text-green-500" />
                        <h3 className="text-sm font-bold text-white">2. Ingestion Pipeline</h3>
                    </div>
                    <Button 
                        size="sm" 
                        variant="outline" 
                        className="h-7 text-xs border-gray-700 hover:bg-gray-800"
                        onClick={() => copyToClipboard(CLIENT_SCRIPT, 'js')}
                    >
                        {copied === 'js' ? <Check className="w-3 h-3 mr-1" /> : <Copy className="w-3 h-3 mr-1" />}
                        {copied === 'js' ? 'Copied' : 'Copy Node.js'}
                    </Button>
                </div>
                <p className="text-xs text-gray-500 mb-3">
                    Save as <code>ingest.js</code> and run locally to push mass data.
                </p>
                <div className="bg-[#111] p-3 rounded-lg border border-[#222] overflow-x-auto">
                    <pre className="text-[10px] text-gray-300 font-mono">{CLIENT_SCRIPT}</pre>
                </div>
            </div>

            {/* Storage Manager */}
            <div className="p-4 rounded-xl bg-[#111] border border-[#222] animate-in fade-in">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <HardDrive className="w-4 h-4 text-yellow-500" />
                        <h3 className="text-sm font-bold text-white">Storage Manager (Free Tier)</h3>
                    </div>
                    <Button 
                        size="icon" 
                        variant="ghost" 
                        className="h-6 w-6" 
                        onClick={fetchStats}
                    >
                        <RefreshCw className={`w-3 h-3 ${loadingStats ? 'animate-spin' : ''}`} />
                    </Button>
                </div>

                {dbStats ? (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="p-2 bg-black rounded border border-[#333]">
                                <span className="text-gray-500 block">Total Records</span>
                                <span className="font-mono text-lg font-bold text-white">
                                    {dbStats.property_count?.toLocaleString()}
                                </span>
                            </div>
                            <div className="p-2 bg-black rounded border border-[#333]">
                                <span className="text-gray-500 block">DB Size</span>
                                <span className="font-mono text-lg font-bold text-white">
                                    {dbStats.database_size}
                                </span>
                            </div>
                        </div>

                        {/* State Breakdown */}
                        {dbStats.state_counts && dbStats.state_counts.length > 0 && (
                            <div className="space-y-2">
                                <p className="text-[10px] font-bold text-gray-500 uppercase">Usage by State</p>
                                {dbStats.state_counts.map((s) => (
                                    <div key={s.state} className="flex items-center justify-between p-2 bg-black/50 rounded border border-[#333]">
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-sm text-white">{s.state || 'Unknown'}</span>
                                            <span className="text-xs text-gray-500">({parseInt(s.count).toLocaleString()})</span>
                                        </div>
                                        <AlertDialog>
                                            <AlertDialogTrigger asChild>
                                                <Button size="sm" variant="ghost" className="h-6 text-red-500 hover:text-red-400 hover:bg-red-950/30">
                                                    <Trash2 className="w-3 h-3 mr-1" /> Delete
                                                </Button>
                                            </AlertDialogTrigger>
                                            <AlertDialogContent className="bg-[#111] border-[#333] text-white">
                                                <AlertDialogHeader>
                                                    <AlertDialogTitle>Delete all {s.state} records?</AlertDialogTitle>
                                                    <AlertDialogDescription>
                                                        This will remove {parseInt(s.count).toLocaleString()} properties from the database. 
                                                        Make sure you have a backup CSV.
                                                    </AlertDialogDescription>
                                                </AlertDialogHeader>
                                                <AlertDialogFooter>
                                                    <AlertDialogCancel className="bg-transparent border-[#333] text-white hover:bg-[#222]">Cancel</AlertDialogCancel>
                                                    <AlertDialogAction 
                                                        onClick={() => handleCleanup('state', s.state)}
                                                        className="bg-red-600 hover:bg-red-700 text-white"
                                                    >
                                                        Delete
                                                    </AlertDialogAction>
                                                </AlertDialogFooter>
                                            </AlertDialogContent>
                                        </AlertDialog>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Zip Code Delete */}
                        <div className="pt-2 border-t border-[#333]">
                            <p className="text-[10px] font-bold text-gray-500 uppercase mb-2">Delete Specific Zip</p>
                            <div className="flex gap-2">
                                <input 
                                    type="text" 
                                    placeholder="Zip Code (e.g. 90210)"
                                    value={targetZip}
                                    onChange={(e) => setTargetZip(e.target.value)}
                                    className="flex-1 bg-black border border-[#333] rounded px-3 py-1 text-sm text-white"
                                />
                                <Button 
                                    size="sm" 
                                    variant="destructive"
                                    disabled={!targetZip}
                                    onClick={() => {
                                        if(confirm(`Delete all records for zip ${targetZip}?`)) {
                                            handleCleanup('zip', targetZip);
                                            setTargetZip("");
                                        }
                                    }}
                                >
                                    Delete
                                </Button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="text-center py-4 text-xs text-gray-500">
                        {loadingStats ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Load stats to manage storage"}
                    </div>
                )}
            </div>
        </div>
    );
}