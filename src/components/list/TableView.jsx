import React from 'react';
import { 
    Table, 
    TableBody, 
    TableCell, 
    TableHead, 
    TableHeader, 
    TableRow 
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";



export default function TableView({ properties, selectedIds, onSelect, onSelectAll }) {
    
    return (
        <div className="border rounded-md border-gray-800 bg-[#111]">
            <Table>
                <TableHeader className="bg-[#1F1F1F]">
                    <TableRow className="border-gray-800 hover:bg-[#1F1F1F]">
                        <TableHead className="w-[50px]">
                            <Checkbox 
                                checked={selectedIds.length === properties.length && properties.length > 0}
                                onCheckedChange={onSelectAll}
                                className="border-gray-500 data-[state=checked]:bg-yellow-500 data-[state=checked]:text-black"
                            />
                        </TableHead>
                        <TableHead className="text-gray-400">Address</TableHead>
                        <TableHead className="text-gray-400">City/Zip</TableHead>
                        <TableHead className="text-gray-400">Status</TableHead>
                        <TableHead className="text-gray-400 text-right">Value</TableHead>
                        <TableHead className="text-gray-400 text-right">Size</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {properties.map((prop) => (
                        <TableRow key={prop.address_hash || prop.id} className="border-gray-800 hover:bg-[#1F1F1F]">
                            <TableCell>
                                <Checkbox 
                                    checked={selectedIds.includes(prop.address_hash || prop.id)}
                                    onCheckedChange={() => onSelect(prop.address_hash || prop.id)}
                                    className="border-gray-500 data-[state=checked]:bg-yellow-500 data-[state=checked]:text-black"
                                />
                            </TableCell>
                            <TableCell className="font-medium text-white">
                                {prop.house_number} {prop.street_name}
                            </TableCell>
                            <TableCell className="text-gray-400">
                                {prop.city}, {prop.zip_code}
                            </TableCell>
                            <TableCell>
                                <Badge variant="outline" className={`
                                    ${prop.effective_status === 'SOLD' ? 'text-green-500 border-green-500' : 
                                      prop.effective_status === 'HARD_NO' ? 'text-red-500 border-red-500' : 
                                      'text-gray-400 border-gray-600'}
                                `}>
                                    {prop.effective_status}
                                </Badge>
                            </TableCell>
                            <TableCell className="text-right text-gray-300">
                                {prop.price ? `$${(prop.price/1000).toFixed(0)}k` : '-'}
                            </TableCell>
                            <TableCell className="text-right text-gray-300">
                                {prop.sqft ? `${prop.sqft.toLocaleString()} sqft` : '-'}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}