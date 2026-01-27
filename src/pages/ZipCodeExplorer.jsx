import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, CircleMarker, Tooltip, LayerGroup } from 'react-leaflet';
import { Search, Loader2, Home, MapPin, ArrowLeft, Navigation, Save, CheckCircle2 } from 'lucide-react';
import { getConnection } from '../components/neonClient';
import { createPageUrl } from '../utils';
import { Link, useNavigate } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { generateOptimizedRoutes } from '../components/logic/routeOptimizer';
import { base44 } from '@/api/base44Client';
import { toast } from "sonner";

// Fix leaflet marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Component to move map to new center
function MapMover({ center, zoom, searchId }) {
  const map = useMap();
  React.useEffect(() => {
    if (center && searchId) {
      map.flyTo(center, zoom || 14);
    }
  }, [searchId]); 
  return null;
}

const ROUTE_COLORS = ['#FFD700', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#a855f7'];

export default function ZipCodeExplorer() {
  const navigate = useNavigate();
  const [zipCode, setZipCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoSearchTriggered, setAutoSearchTriggered] = useState(false);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const zipParam = params.get('zip');
    if (zipParam && !autoSearchTriggered) {
      setZipCode(zipParam);
      setAutoSearchTriggered(true);
      // Trigger search after a short delay to ensure state update
      setTimeout(() => handleSearch(zipParam), 100);
    }
  }, []);
  const [properties, setProperties] = useState([]);
  const [mapCenter, setMapCenter] = useState([39.8283, -98.5795]); // Center of US
  const [mapZoom, setMapZoom] = useState(4);
  const [searchId, setSearchId] = useState(0);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [zipColumn, setZipColumn] = useState('zip_code');
  
  // Route Generation State
  const [generatedRoutes, setGeneratedRoutes] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeRoute, setActiveRoute] = useState(null);

  React.useEffect(() => {
    // Check which zip column exists on mount
    const checkSchema = async () => {
      try {
        const sql = getConnection();
        // Try to query column names dynamically
        const result = await sql`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'properties' 
          AND column_name IN ('zip_code', 'zip', 'postal_code')
        `;
        if (result.length > 0) {
          setZipColumn(result[0].column_name);
          console.log('Using zip column:', result[0].column_name);
        }
      } catch (e) {
        console.error('Schema check failed:', e);
      }
    };
    checkSchema();
  }, []);

  const handleSearch = async (zipOverride = null) => {
    const searchZip = zipOverride || zipCode;
    
    if (!searchZip || searchZip.length < 5) {
      setError('Please enter a valid 5-digit zip code');
      return;
    }
    
    setLoading(true);
    setError(null);
    setGeneratedRoutes([]); // Clear previous routes
    setActiveRoute(null);
    
    try {
      const sql = getConnection();
      const col = zipColumn;

      let results;
      let totalCountRes;

      if (col === 'zip') {
        results = await sql`
          SELECT 
            p.*, 
            COALESCE(p.latitude, z.latitude) as latitude,
            COALESCE(p.longitude, z.longitude) as longitude
          FROM properties p
          LEFT JOIN zip_codes z ON p.zip = z.code
          WHERE p.zip = ${searchZip} 
          LIMIT 1000
        `;
        totalCountRes = await sql`SELECT COUNT(*) as count FROM properties WHERE zip = ${searchZip}`;
      } else if (col === 'postal_code') {
        results = await sql`
          SELECT 
            p.*, 
            COALESCE(p.latitude, z.latitude) as latitude,
            COALESCE(p.longitude, z.longitude) as longitude
          FROM properties p
          LEFT JOIN zip_codes z ON p.postal_code = z.code
          WHERE p.postal_code = ${searchZip} 
          LIMIT 1000
        `;
        totalCountRes = await sql`SELECT COUNT(*) as count FROM properties WHERE postal_code = ${searchZip}`;
      } else {
        // Default to zip_code
        results = await sql`
          SELECT 
            p.*, 
            COALESCE(p.latitude, z.latitude) as latitude,
            COALESCE(p.longitude, z.longitude) as longitude
          FROM properties p
          LEFT JOIN zip_codes z ON p.zip_code = z.code
          WHERE p.zip_code = ${searchZip} 
          LIMIT 1000
        `;
        totalCountRes = await sql`SELECT COUNT(*) as count FROM properties WHERE zip_code = ${searchZip}`;
      }
      
      if (results.length === 0) {
        setError(`No properties found in zip code ${searchZip}`);
        setProperties([]);
        setStats(null);
        return;
      }
      
      // Map properties to standard format expected by optimizer
      const mappedProps = results.map(p => ({
        ...p,
        lat: parseFloat(p.latitude),
        lng: parseFloat(p.longitude),
        address_hash: p.address_hash || p.id, // Fallback ID
        effective_status: 'ELIGIBLE' // Default for new generation
      })).filter(p => !isNaN(p.lat) && !isNaN(p.lng));

      setProperties(mappedProps);
      
      // Calculate center from first property with lat/lng
      if (mappedProps.length > 0) {
        const avgLat = mappedProps.reduce((sum, p) => sum + p.lat, 0) / mappedProps.length;
        const avgLng = mappedProps.reduce((sum, p) => sum + p.lng, 0) / mappedProps.length;
        setMapCenter([avgLat, avgLng]);
        setMapZoom(14);
        setSearchId(prev => prev + 1); // Trigger map move
      } else {
        setError('Properties found but they have no latitude/longitude data.');
      }
      
      // Stats
      setStats({
        total: parseInt(totalCountRes[0].count),
        shown: results.length,
        mapped: mappedProps.length,
        avgScore: results.filter(p => p.smart_score).length > 0 
          ? (results.filter(p => p.smart_score).reduce((sum, p) => sum + parseFloat(p.smart_score), 0) / results.filter(p => p.smart_score).length).toFixed(1)
          : null
      });
      
    } catch (err) {
      console.error(err);
      setError(`Database error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateRoutes = () => {
    if (properties.length === 0) return;
    
    setIsGenerating(true);
    // Add small delay to allow UI to update
    setTimeout(() => {
      try {
        const routes = generateOptimizedRoutes(properties, 50, null, [], { streetCooldownDays: 0, useStreetSweep: true });
        setGeneratedRoutes(routes);
        toast.success(`Generated ${routes.length} optimized routes!`);
      } catch (e) {
        console.error(e);
        toast.error("Failed to generate routes");
      } finally {
        setIsGenerating(false);
      }
    }, 100);
  };

  const handleSaveAllRoutes = async () => {
    if (generatedRoutes.length === 0) return;
    
    setIsSaving(true);
    try {
      // Save all routes to DB
      const promises = generatedRoutes.map(route => {
        return base44.entities.SavedRoute.create({
          name: `${zipCode} - ${route.name}`,
          description: `Auto-generated route in ${zipCode}. Score: ${route.competitivenessScore}`,
          property_hashes: route.properties.map(p => p.address_hash),
          metrics: {
            distance: route.totalDistance,
            house_count: route.houseCount,
            score: route.competitivenessScore
          },
          status: 'PENDING',
          start_location: {
              lat: route.properties[0].lat,
              lng: route.properties[0].lng,
              address: `${zipCode} Center`
          }
        });
      });
      
      await Promise.all(promises);
      toast.success(`Successfully saved ${generatedRoutes.length} routes to registry!`);
      
      // Redirect back to Admin Team
      navigate(createPageUrl('AdminTeam'));
      
    } catch (e) {
      console.error(e);
      toast.error("Failed to save routes");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-white">
      {/* Header */}
      <div className="bg-white border-b p-4 shadow-sm z-10 flex flex-col gap-4">
        <div className="max-w-7xl mx-auto w-full flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link to={createPageUrl('AdminTeam')}>
              <Button variant="ghost" size="icon">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-xl font-bold flex items-center gap-2">
                <Navigation className="w-6 h-6 text-blue-600" />
                Route Generator
              </h1>
              <p className="text-xs text-gray-500">Manager Access Only</p>
            </div>
          </div>
          
          <div className="flex-1 max-w-md flex gap-2">
            <Input
              placeholder="Enter zip code (e.g., 29401)"
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="font-mono text-lg"
            />
            <Button onClick={handleSearch} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search
            </Button>
          </div>
          
          <div className="flex gap-2">
             {properties.length > 0 && generatedRoutes.length === 0 && (
                <Button 
                    onClick={handleGenerateRoutes} 
                    disabled={isGenerating}
                    className="bg-blue-600 hover:bg-blue-700"
                >
                    {isGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Navigation className="w-4 h-4 mr-2" />}
                    Generate Routes
                </Button>
             )}
             
             {generatedRoutes.length > 0 && (
                <Button 
                    onClick={handleSaveAllRoutes} 
                    disabled={isSaving}
                    className="bg-green-600 hover:bg-green-700"
                >
                    {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                    Save {generatedRoutes.length} Routes
                </Button>
             )}
          </div>
        </div>
        
        {/* Stats Bar */}
        {stats && (
            <div className="max-w-7xl mx-auto w-full flex items-center gap-6 text-sm border-t pt-2">
              <Badge variant="outline" className="text-base px-3 py-1">
                <Home className="w-4 h-4 mr-1" />
                {stats.mapped.toLocaleString()} Mappable Properties
              </Badge>
              {stats.total > stats.mapped && (
                  <span className="text-yellow-600 text-xs">
                      ({stats.total - stats.mapped} properties missing coordinates)
                  </span>
              )}
              {stats.avgScore && (
                <Badge className="bg-green-100 text-green-800 text-base px-3 py-1">
                  Avg Score: {stats.avgScore}
                </Badge>
              )}
              {generatedRoutes.length > 0 && (
                  <Badge className="bg-blue-100 text-blue-800 text-base px-3 py-1">
                      {generatedRoutes.length} Routes Created
                  </Badge>
              )}
            </div>
        )}
        
        {error && (
          <div className="max-w-7xl mx-auto w-full">
            <p className="text-red-600 text-sm font-medium bg-red-50 p-2 rounded border border-red-100">{error}</p>
          </div>
        )}
      </div>
      
      {/* Map */}
      <div className="flex-1 relative bg-gray-100 flex">
        
        {/* Sidebar for Routes */}
        {generatedRoutes.length > 0 && (
            <div className="w-80 bg-white border-r overflow-y-auto hidden md:block z-[500]">
                <div className="p-4 border-b bg-gray-50">
                    <h3 className="font-bold text-gray-700">Generated Routes</h3>
                </div>
                <div>
                    {generatedRoutes.map((route, idx) => (
                        <React.Fragment key={idx}>
                            <div 
                                onClick={() => setActiveRoute(route)}
                                className={`p-4 border-b cursor-pointer hover:bg-gray-50 transition-colors ${activeRoute === route ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}
                            >
                                <div className="flex justify-between items-start mb-1">
                                    <span className="font-bold text-sm" style={{ color: ROUTE_COLORS[idx % ROUTE_COLORS.length] }}>
                                        {route.name}
                                    </span>
                                    <Badge variant="outline" className="text-xs">{route.houseCount}</Badge>
                                </div>
                                <div className="flex justify-between text-xs text-gray-500">
                                    <span>{route.totalDistance} mi</span>
                                    <span>Score: {route.competitivenessScore}</span>
                                </div>
                            </div>
                            
                            {/* Expanded Property List */}
                            {activeRoute === route && (
                                <div className="bg-gray-50 border-b overflow-x-auto">
                                    <table className="w-full text-xs text-left">
                                        <thead className="bg-gray-100 text-gray-500 uppercase font-medium border-b">
                                            <tr>
                                                <th className="px-3 py-2 w-8">#</th>
                                                <th className="px-3 py-2">Address</th>
                                                <th className="px-3 py-2">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-200">
                                            {route.properties.map((p, pIdx) => (
                                                <tr key={pIdx} className="hover:bg-blue-50/50">
                                                    <td className="px-3 py-2 font-medium text-gray-500">{pIdx + 1}</td>
                                                    <td className="px-3 py-2">
                                                        <div className="font-medium text-gray-900 truncate max-w-[140px]" title={p.address || p.full_address}>
                                                            {p.address || p.full_address}
                                                        </div>
                                                        <div className="text-gray-500">{p.city}</div>
                                                    </td>
                                                    <td className="px-3 py-2">
                                                        <Badge variant="secondary" className="text-[10px] h-5 px-1">
                                                            {p.effective_status || p.original_status || 'ELIGIBLE'}
                                                        </Badge>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </React.Fragment>
                    ))}
                </div>
            </div>
        )}

        <div className="flex-1 relative">
            <MapContainer
            center={mapCenter}
            zoom={mapZoom}
            className="h-full w-full absolute inset-0"
            style={{ height: '100%', width: '100%' }}
            >
            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapMover center={mapCenter} zoom={mapZoom} searchId={searchId} />
            
            {/* Properties (Before Generation) */}
            {generatedRoutes.length === 0 && (
                <LayerGroup>
                    {properties.map((property, idx) => (
                        <CircleMarker 
                        key={property.address_hash || idx} 
                        center={[property.lat, property.lng]}
                        radius={6}
                        pathOptions={{ 
                            fillColor: '#3b82f6', 
                            fillOpacity: 0.8, 
                            color: '#1d4ed8', 
                            weight: 2,
                            stroke: true
                        }}
                        >
                        <Popup>
                            <div className="text-sm">
                            <p className="font-bold">{property.address || property.full_address}</p>
                            <p className="text-xs text-gray-500">{property.city}, {property.state}</p>
                            </div>
                        </Popup>
                        </CircleMarker>
                    ))}
                </LayerGroup>
            )}

            {/* Generated Routes */}
            <LayerGroup>
                {generatedRoutes.map((route, rIdx) => {
                    const color = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                    const isActive = activeRoute === route;
                    
                    return (
                        <React.Fragment key={rIdx}>
                            {/* Route Path (only if active) */}
                            {isActive && (
                                <Polyline 
                                    positions={route.properties.map(p => [p.lat, p.lng])}
                                    pathOptions={{ color: color, weight: 3, opacity: 0.8, dashArray: '5, 10' }}
                                />
                            )}

                            {/* Route Points */}
                            {route.properties.map((p, pIdx) => (
                                <CircleMarker
                                    key={`${rIdx}-${pIdx}`}
                                    center={[p.lat, p.lng]}
                                    radius={isActive ? 8 : 5}
                                    eventHandlers={{
                                        click: () => setActiveRoute(route)
                                    }}
                                    pathOptions={{ 
                                        fillColor: color, 
                                        fillOpacity: isActive ? 0.9 : 0.6, 
                                        color: 'white', 
                                        weight: 1 
                                    }}
                                >
                                    {isActive && (
                                        <Tooltip permanent direction="center" className="bg-transparent border-0 shadow-none text-white font-bold text-[10px]">
                                            {pIdx + 1}
                                        </Tooltip>
                                    )}
                                </CircleMarker>
                            ))}
                        </React.Fragment>
                    );
                })}
            </LayerGroup>
            </MapContainer>
        </div>
      </div>
    </div>
  );
}