"""Find the correct region type for ID 12253 and search for other IDs"""
import requests
import re
import json

def test_region_type(region_id, region_type, expected_state="SC"):
    """Test a region ID with a specific type"""
    
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
        'Accept': 'text/csv,text/plain,*/*',
        'X-RF-Stingray-Xhr': '1',
        'Referer': 'https://www.redfin.com/',
    }
    
    try:
        response = requests.get(url, params=params, headers=headers, timeout=30)
        
        if response.status_code == 200 and len(response.text) > 500:
            # Quick check for state
            lines = response.text.split('\n')
            
            # Find state column
            header = lines[0] if lines else ""
            state_col = None
            cols = header.split(',')
            for i, col in enumerate(cols):
                if 'STATE' in col.upper():
                    state_col = i
                    break
            
            # Check data rows
            states = {}
            for line in lines[5:20]:  # Check up to 15 data rows
                parts = line.split(',')
                if len(parts) > state_col:
                    state = parts[state_col].strip().strip('"')
                    if state and len(state) == 2:
                        states[state] = states.get(state, 0) + 1
            
            if expected_state in states:
                return True, states
            elif states:
                return False, states
                
    except Exception as e:
        return None, str(e)
    
    return None, "No data"


# Test all region types for ID 12253
print("Testing Region ID 12253 with different types:")
print("="*60)

region_types = {
    1: "Zip",
    2: "City",
    3: "Neighborhood",
    4: "Metro",
    5: "County",
    6: "State",
    7: "School District",
    8: "Address",
}

for type_num, type_name in region_types.items():
    result, info = test_region_type(12253, type_num)
    status = "✓" if result else "✗" if result == False else "?"
    print(f"Type {type_num} ({type_name}): {status} - {info}")

# Now let's find all region IDs in the property page HTML
print("\n" + "="*60)
print("Extracting ALL region IDs from property page:")
print("="*60)

property_id = "129324693"
url = f"https://www.redfin.com/SC/Westminster/102-Blossom-Ct-29693/home/{property_id}"

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
}

response = requests.get(url, headers=headers, timeout=30)

if response.status_code == 200:
    html = response.text
    
    # Find all region IDs
    patterns = [
        r'regionId["\']?\s*:\s*(\d+)',
        r'"regionId"\s*:\s*(\d+)',
        r'\"regionId\"\s*:\s*(\d+)',
        r'region_id["\']?\s*:\s*(\d+)',
        r'parentRegionId["\']?\s*:\s*(\d+)',
    ]
    
    all_ids = set()
    for pattern in patterns:
        matches = re.findall(pattern, html)
        all_ids.update(matches)
    
    print(f"Found {len(all_ids)} unique region IDs: {sorted(all_ids, key=int)}")
    
    # Test each ID as type 5 (county)
    print("\nTesting all found IDs as County (type 5):")
    print("-"*60)
    
    for region_id in sorted(all_ids, key=int):
        result, info = test_region_type(region_id, 5, "SC")
        if result:
            print(f"ID {region_id}: ✓✓✓ SC DATA FOUND! ✓✓✓")
        elif result == False:
            print(f"ID {region_id}: ✗ Wrong state ({info})")
        else:
            print(f"ID {region_id}: ? No data")
