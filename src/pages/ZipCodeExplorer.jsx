import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { Search, Loader2, Home, MapPin, ArrowLeft } from 'lucide-react';
import { getConnection } from '../components/neonClient';
import { createPageUrl } from '../utils';
import { Link } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix leaflet marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Component to move map to new center
function MapMover({ center, zoom }) {
  const map = useMap();
  React.useEffect(() => {
    if (center) {
      map.flyTo(center, zoom || 14);
    }
  }, [center, zoom, map]);
  return null;
}

export default function ZipCodeExplorer() {
  const [zipCode, setZipCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [properties, setProperties] = useState([]);
  const [mapCenter, setMapCenter] = useState([39.8283, -98.5795]); // Center of US
  const [mapZoom, setMapZoom] = useState(4);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [zipColumn, setZipColumn] = useState('zip_code');

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

  const handleSearch = async () => {
    if (!zipCode || zipCode.length < 5) {
      setError('Please enter a valid 5-digit zip code');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const sql = getConnection();
      const col = zipColumn;

      // Conditional query construction
      let results;
      let totalCountRes;
      
      if (col === 'zip') {
        results = await sql`SELECT * FROM properties WHERE zip = ${zipCode} LIMIT 500`;
        totalCountRes = await sql`SELECT COUNT(*) as count FROM properties WHERE zip = ${zipCode}`;
      } else if (col === 'postal_code') {
        results = await sql`SELECT * FROM properties WHERE postal_code = ${zipCode} LIMIT 500`;
        totalCountRes = await sql`SELECT COUNT(*) as count FROM properties WHERE postal_code = ${zipCode}`;
      } else {
        // Default to zip_code
        results = await sql`SELECT * FROM properties WHERE zip_code = ${zipCode} LIMIT 500`;
        totalCountRes = await sql`SELECT COUNT(*) as count FROM properties WHERE zip_code = ${zipCode}`;
      }
      
      if (results.length === 0) {
        setError(`No properties found in zip code ${zipCode}`);
        setProperties([]);
        setStats(null);
        return;
      }
      
      setProperties(results);
      
      // Calculate center from first property with lat/lng
      const withCoords = results.filter(p => p.latitude && p.longitude);
      if (withCoords.length > 0) {
        const avgLat = withCoords.reduce((sum, p) => sum + parseFloat(p.latitude), 0) / withCoords.length;
        const avgLng = withCoords.reduce((sum, p) => sum + parseFloat(p.longitude), 0) / withCoords.length;
        setMapCenter([avgLat, avgLng]);
        setMapZoom(14);
      } else {
        setError('Properties found but they have no latitude/longitude data.');
      }
      
      // Stats
      setStats({
        total: parseInt(totalCountRes[0].count),
        shown: results.length,
        withScore: results.filter(p => p.smart_score).length,
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

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b p-4 shadow-sm z-10">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-4">
          <Link to={createPageUrl('DatabaseDiagnostic')} className="mr-2">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <MapPin className="w-6 h-6 text-blue-600" />
            Zip Code Explorer
          </h1>
          
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
          
          {stats && (
            <div className="flex items-center gap-4 text-sm hidden md:flex">
              <Badge variant="outline" className="text-base px-3 py-1">
                <Home className="w-4 h-4 mr-1" />
                {stats.total.toLocaleString()} properties
              </Badge>
              {stats.avgScore && (
                <Badge className="bg-green-100 text-green-800 text-base px-3 py-1">
                  Avg Score: {stats.avgScore}
                </Badge>
              )}
            </div>
          )}
        </div>
        
        {error && (
          <div className="max-w-7xl mx-auto mt-2">
            <p className="text-red-600 text-sm font-medium">{error}</p>
          </div>
        )}
      </div>
      
      {/* Map */}
      <div className="flex-1 relative bg-gray-100">
        <MapContainer
          center={mapCenter}
          zoom={mapZoom}
          className="h-full w-full absolute inset-0"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapMover center={mapCenter} zoom={mapZoom} />
          
          {properties.filter(p => p.latitude && p.longitude).map((property, idx) => (
            <Marker 
              key={idx} 
              position={[parseFloat(property.latitude), parseFloat(property.longitude)]}
            >
              <Popup>
                <div className="text-sm min-w-[200px]">
                  <p className="font-bold text-base mb-1">{property.address || 'No address'}</p>
                  <p className="text-gray-600 mb-2">{property.city}, {property.state} {property.zip_code}</p>
                  
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {property.smart_score && (
                      <div className="col-span-2">
                        <Badge className="bg-green-100 text-green-800 hover:bg-green-100 w-full justify-center">
                          Score: {property.smart_score}
                        </Badge>
                      </div>
                    )}
                    <div className="bg-gray-50 p-1 rounded">Beds: <b>{property.beds}</b></div>
                    <div className="bg-gray-50 p-1 rounded">Baths: <b>{property.baths}</b></div>
                    <div className="bg-gray-50 p-1 rounded">Sqft: <b>{parseInt(property.sqft || 0).toLocaleString()}</b></div>
                    <div className="bg-gray-50 p-1 rounded">Year: <b>{property.year_built}</b></div>
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}