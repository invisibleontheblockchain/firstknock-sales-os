"""Use poly search to find properties across entire Oconee County"""
import requests
import json
import re
import time

def poly_search_oconee():
    """Search Oconee County using poly bounding box"""
    
    url = "https://www.redfin.com/stingray/api/gis"
    
    # Oconee County, SC bounding box
    # Covering: Walhalla, Westminster, Seneca, West Union, Clemson area
    # Format: long lat, long lat...
    oconee_poly = "-83.15 34.60,-82.80 34.60,-82.80 34.90,-83.15 34.90,-83.15 34.60"
    
    params = {
        'al': 1,
        'poly': oconee_poly,
        'status': 9,  # Sold
        'num_homes': 50,
        'v': 8
    }
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    print("Searching Oconee County with poly bounding box...")
    print(f"Poly: {oconee_poly}\n")
    
    response = requests.get(url, params=params, headers=headers, timeout=30)
    
    if response.status_code == 200:
        content = response.text
        if content.startswith("{}&&"):
            content = content[4:]
        
        data = json.loads(content)
        payload = data.get('payload', {})
        homes = payload.get('homes', [])
        
        print(f"Found {len(homes)} homes")
        print(f"Service Region: {payload.get('serviceRegionName', 'N/A')}\n")
        
        # Collect cities
        cities = {}
        for home in homes:
            city = home.get('city')
            state = home.get('state')
            if city and state:
                key = f"{city}, {state}"
                cities[key] = cities.get(key, 0) + 1
        
        print("Cities found in results:")
        for city, count in sorted(cities.items()):
            print(f"  {city}: {count} properties")
        
        return homes
    else:
        print(f"Failed: {response.status_code}")
        return []


def extract_region_ids_from_page(url_suffix):
    """Extract all region IDs from a Redfin property page"""
    url = f"https://www.redfin.com{url_suffix}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=20)
        if response.status_code == 200:
            html = response.text
            
            # Find all potential region IDs (4-6 digit numbers that could be region IDs)
            ids = set()
            
            # Look for patterns in the HTML
            patterns = [
                r'"regionId":(\d{2,6})',
                r'regionId["\']?\s*:\s*(\d{2,6})',
                r'"id":(\d{4,6})[^}]*"type":',
                r'/region/(\d+)',
            ]
            
            for pattern in patterns:
                matches = re.findall(pattern, html)
                for match in matches:
                    id_num = int(match)
                    if 1000 < id_num < 50000:  # Reasonable range for region IDs
                        ids.add(id_num)
            
            return ids
    except Exception as e:
        print(f"  Error: {e}")
    
    return set()


# Main execution
homes = poly_search_oconee()

if homes:
    print("\n" + "="*60)
    print("Extracting region IDs from sample properties:")
    print("="*60)
    
    all_ids = set()
    
    # Sample 10 different properties
    sample_size = min(10, len(homes))
    for i, home in enumerate(homes[:sample_size]):
        url = home.get('url')
        city = home.get('city')
        
        if url:
            print(f"\n{i+1}. Property in {city}: {url}")
            ids = extract_region_ids_from_page(url)
            print(f"   Region IDs found: {ids if ids else 'None'}")
            all_ids.update(ids)
            time.sleep(1.5)
    
    print("\n" + "="*60)
    print(f"Total unique region IDs found: {sorted(all_ids)}")
    print("="*60)
    
    # Test each ID as county (type 5)
    print("\nTesting as County (Type 5):")
    
    for region_id in sorted(all_ids):
        # Quick test
        test_url = "https://www.redfin.com/stingray/api/gis-csv"
        params = {
            'al': 1,
            'region_id': region_id,
            'region_type': 5,
            'sold_within_days': 1825,
            'status': '9',
            'v': 8
        }
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'X-RF-Stingray-Xhr': '1',
        }
        
        try:
            response = requests.get(test_url, params=params, headers=headers, timeout=30)
            if response.status_code == 200:
                text = response.text
                if len(text) > 2000:
                    # Check first 5000 chars for SC
                    sample = text[:5000]
                    sc_count = sample.count(',SC,')
                    if sc_count > 0:
                        print(f"✓✓✓ ID {region_id}: {sc_count} SC properties found! ✓✓✓")
                    else:
                        # Find what states it does have
                        import csv
                        import io
                        reader = csv.reader(io.StringIO(text))
                        rows = list(reader)
                        if len(rows) > 5:
                            state_col = 5  # Usually column 5
                            states = {}
                            for row in rows[5:]:
                                if len(row) > state_col:
                                    state = row[state_col].strip()
                                    if state and len(state) == 2:
                                        states[state] = states.get(state, 0) + 1
                            if states:
                                print(f"ID {region_id}: {states}")
                else:
                    print(f"ID {region_id}: Empty response")
        except Exception as e:
            print(f"ID {region_id}: Error - {e}")
        
        time.sleep(1)
