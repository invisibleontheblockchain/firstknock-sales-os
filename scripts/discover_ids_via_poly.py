import requests
import json
import time

def discover_region_id(poly_str, name):
    url = "https://www.redfin.com/stingray/api/gis"
    
    # Precise headers to mimic a browser search
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    params = {
        'al': 1,
        'poly': poly_str,
        'status': 9, # Sold
        'num_homes': 10,
        'v': 8
    }
    
    print(f"Discovering ID for {name} using poly: {poly_str}...")
    
    try:
        response = requests.get(url, params=params, headers=headers, timeout=30)
        if response.status_code == 200:
            content = response.text
            if content.startswith("{}&&"):
                content = content[4:]
            
            data = json.loads(content)
            
            # The regionId is often in the payload -> metadata or similar
            payload = data.get('payload', {})
            
            # Look for regionId in common places
            region_id = payload.get('regionId')
            region_type = payload.get('regionType')
            
            # Sometimes it's in the search title or breadcrumbs
            title = payload.get('title', '')
            
            print(f"SUCCESS: Found metadata for {name}")
            print(f"Title: {title}")
            print(f"Region ID: {region_id}")
            print(f"Region Type: {region_type}")
            
            return {
                'name': name,
                'region_id': region_id,
                'region_type': region_type,
                'title': title
            }
        else:
            print(f"FAILED: Status {response.status_code}")
            return None
    except Exception as e:
        print(f"ERROR: {e}")
        return None

if __name__ == "__main__":
    # Oconee County Box (approx Seneca area)
    # format: long lat, long lat...
    # Seneca SC is ~ -82.98 34.68
    oconee_poly = "-83.15 34.50,-82.80 34.50,-82.80 34.95,-83.15 34.95,-83.15 34.50"
    
    # Greenville SC Box
    # Greenville area is ~ -82.40 34.85
    greenville_poly = "-82.60 34.60,-82.10 34.60,-82.10 35.10,-82.60 35.10,-82.60 34.60"
    
    # Anderson SC Box
    # Anderson area is ~ -82.65 34.50
    anderson_poly = "-82.85 34.30,-82.35 34.30,-82.35 34.70,-82.85 34.70,-82.85 34.30"
    
    results = []
    results.append(discover_region_id(oconee_poly, "Oconee"))
    time.sleep(5)
    results.append(discover_region_id(greenville_poly, "Greenville"))
    time.sleep(5)
    results.append(discover_region_id(anderson_poly, "Anderson"))
    
    with open('scripts/discovered_region_ids.json', 'w') as f:
        json.dump([r for r in results if r], f, indent=4)
