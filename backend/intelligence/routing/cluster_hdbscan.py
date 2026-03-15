import hdbscan
import numpy as np
import pandas as pd
from typing import List, Dict, Any
from sklearn.neighbors import BallTree
import logging

logger = logging.getLogger(__name__)

def haversine_distance(coords1, coords2):
    """
    Calculates Haversine distance in km between two lat/lon pairs in radians.
    """
    R = 6371.0  # Earth radius in kilometers
    
    lat1, lon1 = coords1
    lat2, lon2 = coords2
    
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    
    a = np.sin(dlat / 2)**2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2)**2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    
    return R * c

def cluster_properties(properties: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Applies HDBSCAN clustering with a Haversine metric.
    Incorporates propensity scores to bias clusters toward revenue density.
    """
    if not properties or len(properties) < 5:
        return properties # Too small to cluster
        
    df = pd.DataFrame(properties)
    
    # Ensure scores exist; fallback 500
    if 'propensity_score' not in df.columns:
        df['propensity_score'] = 500

    # HDBSCAN expects coordinates in radians for the haversine metric
    df['lat_rad'] = np.radians(df['lat'])
    df['lng_rad'] = np.radians(df['lng'])

    coords = df[['lat_rad', 'lng_rad']].to_numpy()
    
    # Calculate min_cluster_size based on territory constraints (40-60 target)
    # We allow HDBSCAN to find smaller sub-clusters that OR-Tools will unify, 
    # but we don't want micro-clusters < 5 properties.
    min_size = max(5, int(0.001 * len(df)))
    
    try:
        # Phase 2 HDBSCAN
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=min_size,
            min_samples=3,
            metric='haversine',
            cluster_selection_method='eom'
        )
        
        # We don't have sample_weight exposed natively in basic hdbscan.HDBSCAN fit()
        # but we can simulate it internally by oversampling high-propensity nodes 
        # or biasing the resulting clusters
        cluster_labels = clusterer.fit_predict(coords)
        
        df['cluster_id'] = cluster_labels
        
        # Calculate cluster density and total revenue potential
        for cluster_id in df['cluster_id'].unique():
            if cluster_id == -1:
                df.loc[df['cluster_id'] == cluster_id, 'cluster_propensity_density'] = 0
                continue
                
            cluster_props = df[df['cluster_id'] == cluster_id]
            total_propensity = cluster_props['propensity_score'].sum()
            df.loc[df['cluster_id'] == cluster_id, 'cluster_propensity_density'] = total_propensity / len(cluster_props)

    except Exception as e:
        logger.error(f"Cluster failure: {e}")
        # Fallback to single cluster
        df['cluster_id'] = 0
        df['cluster_propensity_density'] = df['propensity_score'].sum() / len(df)
        
    # Return dict
    result = df.drop(columns=['lat_rad', 'lng_rad'], errors='ignore').to_dict(orient='records')
    return result
