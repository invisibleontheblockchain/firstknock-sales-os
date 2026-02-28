import requests
import json
import time

def get_region_metadata(poly_str, name):
    url = "https://www.redfin.com/stingray/api/gis"
    params = {
        'al': 1,
        'poly': poly_str,
        'status': 9, # Sold
        'num_homes': 10,
        'v': 8
    }
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    print(f"Querying Redfin for {name} bounding box...")
    try:
        response = requests.get(url, params=params, headers=headers, timeout=30)
        print(f"Status: {response.status_code}")
        
        text = response.text
        if text.startswith('{}&&'):
            text = text[4:]
        
        data = json.loads(text)
        payload = data.get('payload', {})
        
        # Check metadata
        metadata = payload.get('metadata', {})
        region_id = payload.get('regionId')
        region_type = payload.get('regionType')
        
        print(f"DEBUG: regionId in payload: {region_id}")
        print(f"DEBUG: regionType in payload: {region_type}")
        
        # Let's save the full payload for inspection
        with open(f'scripts/{name.lower()}_payload.json', 'w') as f:
            json.dump(data, f, indent=4)
            
        # Check first home for its parent region
        homes = payload.get('homes', [])
        if homes:
            first_home = homes[0]
            print(f"Sample home found: {first_home.get('address', {}).get('streetLine')}")
            
        return region_id, region_type
    except Exception as e:
        print(f"Error: {e}")
        return None, None

if __name__ == "__main__":
    # Oconee County Bounding Box
    oconee_poly = "-83.35400 34.47203,-82.82915 34.47203,-82.82915 35.05620,-83.35400 35.05620,-83.35400 34.47203"
    
    rid, rtype = get_region_metadata(oconee_poly, "Oconee")
    print(f"FINAL RESULT - Oconee: ID={rid}, Type={rtype}")
