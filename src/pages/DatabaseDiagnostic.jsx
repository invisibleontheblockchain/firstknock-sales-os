import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Database, 
  CheckCircle, 
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

        <Card className="mb-6">
          <CardContent className="pt-6">
            <Button 
              onClick={handleRunDiagnostic} 
              disabled={loading}
              size="lg"
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Running Diagnostic...
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