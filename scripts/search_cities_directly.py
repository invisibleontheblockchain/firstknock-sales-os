"""Search for Oconee County cities directly using autocomplete"""
import requests
import json
import time

def search_location(query):
    """Search for a location using Redfin's autocomplete"""
    url = "https://www.redfin.com/stingray/do/location-autocomplete"
    params = {'location': query, 'v': '2'}
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    try:
        response = requests.get(url, params=params, headers=headers, timeout=15)
        if response.status_code == 200:
            text = response.text
            if text.startswith('{}&&'):
                text = text[4:]
            data = json.loads(text)
            
            sections = data.get('payload', {}).get('sections', [])
            rows = []
            for section in sections:
                rows.extend(section.get('rows', []))
            
            return rows
    except Exception as e:
        print(f"Error: {e}")
    
    return []


def test_region(region_id, region_type, name):
    """Test if a region ID returns SC data"""
    url = "https://www.redfin.com/stingray/api/gis-csv"
    params = {
        'al': 1,
        'region_id': region_id,
        'region_type': region_type,
        'sold_within_days': 1825,
        'status': '9',
        'v': 8
    }
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-RF-Stingray-Xhr': '1',
    }
    
    try:
        response = requests.get(url, params=params, headers=headers, timeout=30)
        if response.status_code == 200:
            text = response.text
            if ',SC,' in text[:10000] and len(text) > 2000:
                # Count SC occurrences
                sc_count = text.count(',SC,')
                return True, sc_count
            elif len(text) > 2000:
                # Wrong state
                import csv
                import io
                reader = csv.reader(io.StringIO(text))
                rows = list(reader)
                if len(rows) > 5:
                    states = {}
                    for row in rows[5:20]:
                        if len(row) > 5:
                            state = row[5].strip()
                            if state and len(state) == 2:
                                states[state] = states.get(state, 0) + 1
                    return False, states
        return None, "Empty or failed"
    except Exception as e:
        return None, str(e)


# Search for Oconee County cities
searches = [
    "Seneca, SC",
    "Walhalla, SC",
    "West Union, SC",
    "Westminster, SC",
    "Oconee County, SC",
    "Anderson, SC",
    "Greenville, SC",
]

print("Searching for cities and counties in SC:")
print("="*60)

results = {}

for query in searches:
    print(f"\nSearching: '{query}'")
    rows = search_location(query)
    
    if not rows:
        print("  No results (API blocked)")
        continue
    
    for row in rows[:3]:  # Check top 3 results
        name = row.get('name', '')
        full_id = row.get('id', '')
        region_type = row.get('type', '')
        
        # Parse ID
        parts = full_id.split('_')
        if len(parts) > 1:
            region_id = parts[-1]
            region_type = parts[0]
        else:
            region_id = full_id
        
        print(f"  Found: {name}")
        print(f"    ID: {region_id}, Type: {region_type}")
        
        # Test as different types
        print("    Testing...", end=" ")
        
        # Try type 5 (County) first
        success, info = test_region(region_id, 5, name)
        if success:
            print(f"✓✓✓ TYPE 5 (County) WORKS! {info} properties ✓✓✓")
            results[name] = {'id': region_id, 'type': 5, 'count': info}
        elif success == False:
            # Try type 2 (City)
            success2, info2 = test_region(region_id, 2, name)
            if success2:
                print(f"✓ Type 2 (City) works! {info2} properties")
                results[name] = {'id': region_id, 'type': 2, 'count': info2}
            else:
                print(f"✗ Type 5: {info}")
        else:
            print(f"? No data")
        
        time.sleep(1.5)

# Summary
print("\n" + "="*60)
print("SUMMARY - WORKING REGION IDs:")
print("="*60)

for name, info in results.items():
    print(f"{name}:")
    print(f"  Region ID: {info['id']}")
    print(f"  Type: {info['type']}")
    print(f"  Properties: {info['count']}")
    print()
