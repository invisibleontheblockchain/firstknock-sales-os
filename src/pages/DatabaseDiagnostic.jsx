import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { 
  Database, 
  XCircle, 
  Loader2,
  Table,
  Hash,
  MapPin,
  BarChart3
} from 'lucide-react';
import { runDiagnostic } from '../components/neonClient';
import { createPageUrl } from '../utils';
import { Link } from 'react-router-dom';

export default function DatabaseDiagnostic() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [zipCheckInput, setZipCheckInput] = useState('');
  const [zipAnalysis, setZipAnalysis] = useState(null);
  const [analyzingZip, setAnalyzingZip] = useState(false);

  const handleRunDiagnostic = async () => {
    setLoading(true);
    setError(null);
    try {
      const diagnosticResults = await runDiagnostic();
      setResults(diagnosticResults);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckZips = async () => {
    if (!zipCheckInput) return;
    setAnalyzingZip(true);
    setZipAnalysis(null);
    
    try {
        const zips = zipCheckInput.split(',').map(z => z.trim()).filter(Boolean);
        const report = [];

        for (const zip of zips) {
            // 1. Check External DB (Neon)
            const neonRes = await base44.functions.invoke('checkZipData', { zipCode: zip });
            const neonCount = neonRes.data?.zipCoordinateStats?.total || 0; // Using specific zip stats if available
            // Fallback if specific zip stats not returned structure check
            const neonTotal = neonRes.data?.zipCountsForQuery?.[Object.keys(neonRes.data?.zipCountsForQuery || {})[0]] || 0;
            
            // 2. Check Internal DB (Base44)
            const localRes = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 1);
            // Count workaround: filter returns items, if we want total count usually need a different API or just accept partial if paginated.
            // But usually list returns {items, count} if backend supports it, or we assume filter gets a page. 
            // Better: use count function if available or fetch all ids. 
            // For now, let's just say "Synced: X" based on a separate count query if possible, or just estimate.
            // base44 sdk doesn't always expose raw count easily on filter.
            // Let's use a specialized function or assume the list length if small, but zip could be huge.
            // We'll trust the user wants to see "Is it > 0".
            
            // Actually, let's use a cloud function to count internal if we want exact.
            // But for now, let's just try to fetch a small batch to confirm existence.
            const existsLocally = localRes.length > 0 || (localRes.items && localRes.items.length > 0);
            
            report.push({
                zip,
                neonCount: neonTotal || neonCount, // Try to grab from either source
                synced: existsLocally ? "Active" : "Not Found",
                neonData: neonRes.data
            });
        }
        setZipAnalysis(report);

    } catch (e) {
        toast.error("Zip check failed: " + e.message);
    } finally {
        setAnalyzingZip(false);
    }
  };

  const StatusBadge = ({ status }) => {
    const variants = {
      success: 'bg-green-100 text-green-800',
      error: 'bg-red-100 text-red-800',
      missing: 'bg-red-100 text-red-800',
      warning: 'bg-yellow-100 text-yellow-800',
      pending: 'bg-gray-100 text-gray-800'
    };
    return <Badge className={variants[status] || variants.pending}>{status}</Badge>;
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6 flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
              <Database className="w-8 h-8 text-blue-600" />
              Database Diagnostic
            </h1>
            <p className="text-gray-600 mt-2">
              Verify connection to external Neon Postgres and validate data integrity
            </p>
          </div>
          <Link to={createPageUrl('ZipCodeExplorer')}>
            <Button variant="outline" className="gap-2">
              <MapPin className="w-4 h-4" />
              Go to Zip Code Explorer
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">Zip Code Integrity Check</CardTitle>
                    <CardDescription>Compare External Database vs App Data</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex gap-2">
                        <Input 
                            placeholder="Enter Zips (e.g. 29412, 29455)" 
                            value={zipCheckInput}
                            onChange={(e) => setZipCheckInput(e.target.value)}
                        />
                        <Button onClick={handleCheckZips} disabled={analyzingZip}>
                            {analyzingZip ? <Loader2 className="animate-spin" /> : "Check"}
                        </Button>
                    </div>
                    
                    {zipAnalysis && (
                        <div className="space-y-2 mt-2">
                            {zipAnalysis.map((z, i) => (
                                <div key={i} className="flex justify-between items-center p-2 bg-gray-100 rounded text-sm">
                                    <span className="font-bold">{z.zip}</span>
                                    <div className="text-right">
                                        <div className="text-xs text-gray-500">External: {z.neonCount} records</div>
                                        <div className={`font-bold ${z.synced === 'Active' ? 'text-green-600' : 'text-red-500'}`}>
                                            App Status: {z.synced}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
              <CardHeader>
                  <CardTitle className="text-lg">System Diagnostic</CardTitle>
                  <CardDescription>Check connection and schema health</CardDescription>
              </CardHeader>
              <CardContent>
                <Button 
                  onClick={handleRunDiagnostic} 
                  disabled={loading}
                  size="lg"
                  className="w-full"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Running...
                    </>
                  ) : (
                    <>
                      <Database className="w-5 h-5 mr-2" />
                      Run Full Diagnostic
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
        </div>

        {error && (
          <Card className="mb-6 border-red-200 bg-red-50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-red-800">
                <XCircle className="w-5 h-5" />
                <span className="font-medium">Error: {error}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {results && (
          <div className="space-y-4">
            {/* Connection Status */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Database className="w-5 h-5" />
                    Connection
                  </span>
                  <StatusBadge status={results.connection.status} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">{results.connection.message}</p>
              </CardContent>
            </Card>

            {/* Table Check */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Table className="w-5 h-5" />
                    Table Exists
                  </span>
                  <StatusBadge status={results.tableExists.status} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">{results.tableExists.message}</p>
              </CardContent>
            </Card>

            {/* Row Count */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Hash className="w-5 h-5" />
                    Row Count
                  </span>
                  <StatusBadge status={results.rowCount.status} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-blue-600 mb-2">
                  {results.rowCount.count.toLocaleString()}
                </p>
                <p className="text-gray-600">{results.rowCount.message}</p>
              </CardContent>
            </Card>

            {/* Schema */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5" />
                    Schema ({results.schema.columns?.length || 0} columns)
                  </span>
                  <StatusBadge status={results.schema.status} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-48">
                  <div className="space-y-1">
                    {results.schema.columns?.map((col, i) => (
                      <div key={i} className="flex items-center justify-between py-1 px-2 bg-gray-50 rounded text-sm">
                        <span className="font-mono">{col.name}</span>
                        <span className="text-gray-500">{col.type}</span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Smart Score */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5" />
                    Smart Score
                  </span>
                  <StatusBadge status={results.smartScore.status} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600 mb-2">{results.smartScore.message}</p>
                {results.smartScore.stats && Object.keys(results.smartScore.stats).length > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3">
                    <div className="bg-gray-50 p-3 rounded">
                      <p className="text-xs text-gray-500">Min</p>
                      <p className="font-bold">{results.smartScore.stats.min_score}</p>
                    </div>
                    <div className="bg-gray-50 p-3 rounded">
                      <p className="text-xs text-gray-500">Max</p>
                      <p className="font-bold">{results.smartScore.stats.max_score}</p>
                    </div>
                    <div className="bg-gray-50 p-3 rounded">
                      <p className="text-xs text-gray-500">Avg</p>
                      <p className="font-bold">{results.smartScore.stats.avg_score}</p>
                    </div>
                    <div className="bg-gray-50 p-3 rounded">
                      <p className="text-xs text-gray-500">With Score</p>
                      <p className="font-bold">{parseInt(results.smartScore.stats.with_score || 0).toLocaleString()}</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* County */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <MapPin className="w-5 h-5" />
                    County
                  </span>
                  <StatusBadge status={results.county.status} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600">{results.county.message}</p>
                {results.county.stats && results.county.stats.unique_counties && (
                  <p className="text-2xl font-bold text-blue-600 mt-2">
                    {results.county.stats.unique_counties} unique counties
                  </p>
                )}
              </CardContent>
            </Card>

            {/* State Distribution */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <MapPin className="w-5 h-5" />
                    State Distribution (Top 20)
                  </span>
                  <StatusBadge status={results.stateDistribution.status} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {results.stateDistribution.states?.map((state, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className="font-medium">{state.state || 'NULL'}</span>
                      <div className="flex items-center gap-2">
                        <div 
                          className="h-4 bg-blue-500 rounded"
                          style={{ 
                            width: `${Math.min(200, (parseInt(state.count) / parseInt(results.stateDistribution.states[0]?.count || 1)) * 200)}px` 
                          }}
                        />
                        <span className="text-sm text-gray-600 w-24 text-right">
                          {parseInt(state.count).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Sample Records */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <span>Sample Records</span>
                  <StatusBadge status={results.sampleRecords.status} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-64">
                  <pre className="text-xs bg-gray-900 text-green-400 p-4 rounded overflow-x-auto">
                    {JSON.stringify(results.sampleRecords.records, null, 2)}
                  </pre>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}