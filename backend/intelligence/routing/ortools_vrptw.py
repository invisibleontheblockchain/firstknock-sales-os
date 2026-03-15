import math
import numpy as np
from typing import List, Dict, Any
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

def haversine_distance_meters(coords1, coords2):
    """
    Calculates Haversine distance in meters to act as an integer cost matrix for OR-Tools.
    """
    R = 6371000.0  # Earth radius in meters
    
    lat1, lon1 = math.radians(coords1[0]), math.radians(coords1[1])
    lat2, lon2 = math.radians(coords2[0]), math.radians(coords2[1])
    
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    
    a = math.sin(dlat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    return int(R * c)

def create_data_model(properties, depot_coords, num_vehicles=1):
    """Stores the data for the routing problem."""
    data = {}
    
    # Node 0 is the depot
    locations = [depot_coords]
    for p in properties:
        locations.append((p['lat'], p['lng']))
        
    data['locations'] = locations
    data['num_vehicles'] = num_vehicles
    data['depot'] = 0
    return data

def compute_distance_matrix(locations):
    """Creates a distance matrix from locations using Haversine meters."""
    num_locations = len(locations)
    matrix = []
    for from_node in range(num_locations):
        row = []
        for to_node in range(num_locations):
            if from_node == to_node:
                row.append(0)
            else:
                row.append(haversine_distance_meters(locations[from_node], locations[to_node]))
        matrix.append(row)
    return matrix

def optimize_routes(properties: List[Dict[str, Any]], depot: Dict[str, float], max_duration_min: int = 540) -> Dict[str, Any]:
    """
    Optimizes a route passing through all properties returning to depot.
    Uses OR-Tools to solve TSP/VRPTW.
    """
    if not properties:
        return {"route": []}
        
    depot_tuple = (depot['lat'], depot['lng'])
    data = create_data_model(properties, depot_tuple)
    data['distance_matrix'] = compute_distance_matrix(data['locations'])

    # Create the routing index manager.
    manager = pywrapcp.RoutingIndexManager(len(data['distance_matrix']),
                                           data['num_vehicles'], data['depot'])

    # Create Routing Model.
    routing = pywrapcp.RoutingModel(manager)

    def distance_callback(from_index, to_index):
        # Returns the distance between the two nodes.
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return data['distance_matrix'][from_node][to_node]

    transit_callback_index = routing.RegisterTransitCallback(distance_callback)

    # Define cost of each arc.
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)
    
    # Add Distance constraint (Duration proxy assuming 3 miles/hour walk ~ 1.3 meters/sec + interaction time)
    # We use distance as a proxy since we aren't hooking up a real travel-time API yet.
    # Max duration 9 hours -> roughly max 20,000 meters of walking total per route.
    dimension_name = 'Distance'
    routing.AddDimension(
        transit_callback_index,
        0,  # no slack
        25000,  # maximum walking meters per vehicle (approx 9 hours fatigue cap)
        True,  # start cumul to zero
        dimension_name)
    distance_dimension = routing.GetDimensionOrDie(dimension_name)

    # Setting first solution heuristic.
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC)
    search_parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH)
    search_parameters.time_limit.seconds = 3 # Fast response for mobile

    # Solve the problem.
    solution = routing.SolveWithParameters(search_parameters)
    
    if not solution:
        # Fallback to nearest neighbor if ORTools fails to find a solution under max constraints
        return {"route": properties, "error": "No optimized loop found within constraints."}

    # Extract the route
    route = []
    index = routing.Start(0)
    
    # We skip node 0 (depot) when building returning sequence of property dicts
    while not routing.IsEnd(index):
        node_idx = manager.IndexToNode(index)
        if node_idx != 0: 
            # node 1 maps to property 0
            route.append(properties[node_idx - 1])
        index = solution.Value(routing.NextVar(index))
        
    return {"route": route}
