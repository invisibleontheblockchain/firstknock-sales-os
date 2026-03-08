import React, { useMemo } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MapPin } from 'lucide-react';

const STATUS_COLUMNS = {
    'ELIGIBLE': { label: 'To Knock', color: 'bg-gray-500' },
    'CALLBACK': { label: 'Callbacks', color: 'bg-yellow-500' },
    'NO_ANSWER': { label: 'No Answer', color: 'bg-blue-500' },
    'QUALIFIED': { label: 'Leads', color: 'bg-green-500' },
    'SOLD': { label: 'Sold', color: 'bg-green-700' },
    'HARD_NO': { label: 'Rejections', color: 'bg-red-500' }
};

export default function KanbanView({ properties, onStatusChange }) {
    
    // Group properties by status
    const columns = useMemo(() => {
        const cols = Object.keys(STATUS_COLUMNS).reduce((acc, key) => {
            acc[key] = [];
            return acc;
        }, {});

        properties.forEach(p => {
            const status = p.effective_status || 'ELIGIBLE';
            if (cols[status]) {
                cols[status].push(p);
            } else {
                // Fallback for unknown statuses
                if (!cols['ELIGIBLE']) cols['ELIGIBLE'] = [];
                cols['ELIGIBLE'].push(p);
            }
        });
        return cols;
    }, [properties]);

    const onDragEnd = (result) => {
        const { destination, source, draggableId } = result;

        if (!destination) return;
        if (destination.droppableId === source.droppableId && destination.index === source.index) return;

        const property = properties.find(p => p.address_hash === draggableId || p.id === draggableId);
        if (property) {
            onStatusChange(property, destination.droppableId);
        }
    };

    return (
        <DragDropContext onDragEnd={onDragEnd}>
            <div className="flex gap-4 h-full overflow-x-auto pb-4">
                {Object.entries(STATUS_COLUMNS).map(([statusId, config]) => (
                    <div key={statusId} className="flex-shrink-0 w-72 flex flex-col h-full bg-[#111] rounded-xl border border-gray-800">
                        <div className={`p-3 rounded-t-xl border-b border-gray-800 flex justify-between items-center ${config.color} bg-opacity-10`}>
                            <h3 className={`font-bold text-sm ${config.color.replace('bg-', 'text-')}`}>
                                {config.label}
                            </h3>
                            <Badge variant="secondary" className="bg-black/50 text-white border-0">
                                {columns[statusId]?.length || 0}
                            </Badge>
                        </div>
                        
                        <Droppable droppableId={statusId}>
                            {(provided) => (
                                <ScrollArea className="flex-1 p-2">
                                    <div
                                        {...provided.droppableProps}
                                        ref={provided.innerRef}
                                        className="space-y-2 min-h-[100px]"
                                    >
                                        {columns[statusId]?.map((prop, index) => (
                                            <Draggable 
                                                key={prop.address_hash || prop.id} 
                                                draggableId={prop.address_hash || prop.id} 
                                                index={index}
                                            >
                                                {(provided) => (
                                                    <Card
                                                        ref={provided.innerRef}
                                                        {...provided.draggableProps}
                                                        {...provided.dragHandleProps}
                                                        className="bg-[#1F1F1F] border-gray-700 p-3 hover:border-yellow-500 cursor-grab active:cursor-grabbing"
                                                    >
                                                        <div className="flex justify-between items-start mb-2">
                                                            <div className="font-bold text-sm text-white truncate max-w-[180px]">
                                                                {prop.house_number} {prop.street_name}
                                                            </div>
                                                            {prop.price && (
                                                                <span className="text-[10px] text-green-500 font-mono">
                                                                    ${(prop.price/1000).toFixed(0)}k
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-2 text-[10px] text-gray-400">
                                                            <MapPin className="w-3 h-3" />
                                                            {prop.city}
                                                        </div>
                                                        <div className="mt-2 flex justify-between items-center">
                                                            <Badge variant="outline" className="text-[9px] border-gray-600 text-gray-400">
                                                                {prop.sqft} sqft
                                                            </Badge>
                                                            {prop.last_visited && (
                                                                <span className="text-[9px] text-gray-500">
                                                                    Visited: {new Date(prop.last_visited).toLocaleDateString()}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </Card>
                                                )}
                                            </Draggable>
                                        ))}
                                        {provided.placeholder}
                                    </div>
                                </ScrollArea>
                            )}
                        </Droppable>
                    </div>
                ))}
            </div>
        </DragDropContext>
    );
}