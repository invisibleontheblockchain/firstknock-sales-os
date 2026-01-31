import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Check, Copy, Terminal, Database } from "lucide-react";
import { toast } from "sonner";

export default function IngestionTools() {
    const [copied, setCopied] = useState(null);

    const copyToClipboard = (text, id) => {
        navigator.clipboard.writeText(text);
        setCopied(id);
        toast.success("Copied to clipboard");
        setTimeout(() => setCopied(null), 2000);
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
 * CLIENT INGESTION SCRIPT
 * 1. Install dependencies: npm install axios csv-parser
 * 2. Set your PIPELINE_SECRET in Base44 Dashboard -> Settings -> Environment Variables
 * 3. Run: node ingest.js <path_to_csv>
 */
const fs = require('fs');
const axios = require('axios');
const csv = require('csv-parser');

const API_URL = '${window.location.origin}/functions/ingestProperties';
const SECRET_KEY = 'YOUR_PIPELINE_SECRET'; // <--- REPLACE THIS with the secret you set in Dashboard

async function run() {
    const file = process.argv[2];
    if(!file) return console.log('Usage: node ingest.js <file.csv>');
    
    console.log(\`Reading \${file}...\`);
    const rows = [];
    fs.createReadStream(file)
        .pipe(csv())
        .on('data', d => rows.push(mapRow(d)))
        .on('end', () => upload(rows));
}

function mapRow(row) {
    // Map your CSV columns here
    return {
        address: row.Address,
        city: row.City,
        state: row.State,
        zip_code: row.Zip,
        lat: row.Lat,
        lng: row.Lng,
        price: row.Price,
        smart_score: row.Score
    };
}

async function upload(data) {
    const BATCH = 50;
    const totalBatches = Math.ceil(data.length / BATCH);
    
    console.log(\`Starting upload of \${data.length} records in \${totalBatches} batches...\`);

    for(let i=0; i<data.length; i+=BATCH) {
        const batchNum = Math.floor(i/BATCH) + 1;
        try {
            const res = await axios.post(API_URL, { 
                properties: data.slice(i, i+BATCH),
                source: 'LOCAL_SCRIPT' 
            }, {
                headers: { 'x-pipeline-secret': SECRET_KEY }
            });
            
            if(res.data.success) {
                console.log(\`[Batch \${batchNum}/\${totalBatches}] Success: \${res.data.summary.inserted} inserted\`);
            } else {
                console.warn(\`[Batch \${batchNum}] Issues:\`, res.data);
            }
        } catch (err) {
            console.error(\`[Batch \${batchNum}] Failed:\`, err.response?.data || err.message);
        }
        // Small delay to prevent rate limiting
        await new Promise(r => setTimeout(r, 100));
    }
    console.log('Ingestion complete!');
}

run();`;

    return (
        <div className="space-y-6">
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
        </div>
    );
}