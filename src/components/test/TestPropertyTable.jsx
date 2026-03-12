import React, { useState } from 'react';

export default function TestPropertyTable({ properties, onClear }) {
  const [sortBy, setSortBy] = useState('sold_date');
  const [filterStatus, setFilterStatus] = useState('all');

  const filtered = properties.filter(p => {
    if (filterStatus === 'all') return true;
    return p.original_status === filterStatus;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'sold_date') {
      return (b.sold_date || '').localeCompare(a.sold_date || '');
    }
    if (sortBy === 'price') return (b.price || 0) - (a.price || 0);
    if (sortBy === 'address') return (a.full_address || '').localeCompare(b.full_address || '');
    return 0;
  });

  const soldCount = properties.filter(p => p.original_status === 'SOLD').length;
  const mlsCount = properties.filter(p => p.sale_type === 'MLS').length;
  const deedCount = properties.filter(p => p.sale_type === 'Deed' || p.sale_type === 'Market').length;

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0c0c0e] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.04]">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
              Properties ({properties.length})
            </span>
            <span className="text-[10px] text-red-400 font-bold">SOLD: {soldCount}</span>
            <span className="text-[10px] text-blue-400 font-bold">MLS: {mlsCount}</span>
            <span className="text-[10px] text-purple-400 font-bold">Deed: {deedCount}</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="bg-white/5 border border-white/10 text-white text-[10px] rounded px-2 py-1"
            >
              <option value="all">All Status</option>
              <option value="SOLD">SOLD only</option>
              <option value="ELIGIBLE">ELIGIBLE only</option>
            </select>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              className="bg-white/5 border border-white/10 text-white text-[10px] rounded px-2 py-1"
            >
              <option value="sold_date">Sort: Sold Date</option>
              <option value="price">Sort: Price</option>
              <option value="address">Sort: Address</option>
            </select>
            <button onClick={onClear} className="text-[10px] font-bold text-gray-600 hover:text-white">Clear</button>
          </div>
        </div>
      </div>
      <div className="overflow-auto max-h-[400px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#0c0c0e] z-10">
            <tr className="border-b border-white/[0.04] text-gray-500 text-left">
              <th className="px-3 py-2">Address</th>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">Zip</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Sold Date</th>
              <th className="px-3 py-2">Beds/Bath</th>
              <th className="px-3 py-2">Sqft</th>
              <th className="px-3 py-2">Year</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 200).map((p, i) => (
              <tr key={p.id || i} className="border-b border-white/[0.02] hover:bg-white/[0.02]">
                <td className="px-3 py-1.5 text-white font-medium truncate max-w-[200px]">
                  {p.full_address || `${p.house_number} ${p.street_name}`}
                </td>
                <td className="px-3 py-1.5 text-gray-400">{p.city || '-'}</td>
                <td className="px-3 py-1.5 text-gray-400">{p.zip_code || '-'}</td>
                <td className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    p.original_status === 'SOLD' ? 'bg-red-500/20 text-red-400' :
                    p.original_status === 'ELIGIBLE' ? 'bg-green-500/20 text-green-400' :
                    'bg-gray-500/20 text-gray-400'
                  }`}>{p.original_status || '?'}</span>
                </td>
                <td className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    p.sale_type === 'MLS' ? 'bg-blue-500/20 text-blue-400' :
                    'bg-purple-500/20 text-purple-400'
                  }`}>{p.sale_type || 'Deed'}</span>
                </td>
                <td className="px-3 py-1.5 text-gray-300">{p.price ? `$${p.price.toLocaleString()}` : '-'}</td>
                <td className="px-3 py-1.5 text-gray-400">{p.sold_date ? new Date(p.sold_date).toLocaleDateString() : '-'}</td>
                <td className="px-3 py-1.5 text-gray-400">{p.beds || '-'}/{p.baths || '-'}</td>
                <td className="px-3 py-1.5 text-gray-400">{p.sqft ? p.sqft.toLocaleString() : '-'}</td>
                <td className="px-3 py-1.5 text-gray-400">{p.year_built || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}