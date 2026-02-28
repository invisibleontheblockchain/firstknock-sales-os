"""Extract county region ID from city-level data"""
import requests
import re
import json
import time

def get_city_data(region_id, region_type=2):
    """Get GIS data for a city region"""
    url = "https://www.redfin.com/stingray/api/gis"
    
    params = {
        'al': 1,
        'region_id': region_id,
        'region_type': region_type,
        'status': 9,
        'num_homes': 20,
        'v': 8
    }
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    try:
        response = requests.get(url, params=params, headers=headers, timeout=30)
        if response.status_code == 200:
            content = response.text
            if content.startswith("{}&&"):
                content = content[4:]
            return json.loads(content)
    except Exception as e:
        print(f"Error: {e}")
    return None


def extract_region_ids_from_property_page(property_id, property_url):
    """Extract all region IDs from a property page"""
    url = f"https://www.redfin.com{property_url}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=30)
        if response.status_code == 200:
            html = response.text
            
            # Extract all numeric IDs from the HTML
            region_ids = set()
            
            # Pattern 1: regionId fields
            pattern1 = re.findall(r'regionId["\']?\s*:\s*(\d{3,6})', html)
            region_ids.update(pattern1)
            
            # Pattern 2: Other ID fields
            pattern2 = re.findall(r'id["\']?\s*:\s*(\d{3,6})', html)
            region_ids.update(pattern2)
            
            return {int(rid) for rid in region_ids if 1000 < int(rid) < 100000}
    except Exception as e:
        print(f"Error fetching property page: {e}")
    
    return set()


# Get city data for Westminster (ID 12253, Type 2)
print("Fetching Westminster, SC city data (Region ID 12253, Type 2)...")
data = get_city_data(12253, 2)

if data and 'payload' in data:
    homes = data['payload'].get('homes', [])
    print(f"Found {len(homes)} homes in Westminster\n")
    
    # Sample first few homes to extract their region IDs
    all_region_ids = set()
    
    for i, home in enumerate(homes[:5]):
        property_id = home.get('propertyId')
        url = home.get('url')
        
        if property_id and url:
            print(f"Home {i+1}: Property ID {property_id}")
            print(f"  URL: {url}")
            
            # Extract region IDs from property page
            region_ids = extract_region_ids_from_property_page(property_id, url)
            print(f"  Region IDs found: {region_ids}")
            all_region_ids.update(region_ids)
            
            time.sleep(2)  # Be polite
    
    print(f"\n{'='*60}")
    print(f"All unique region IDs found: {sorted(all_region_ids)}")
    print(f"{'='*60}")
    
    # Now test each region ID as type 5 (County)
    print("\nTesting all found IDs as County (Type 5):")
    
    for region_id in sorted(all_region_ids):
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
            if response.status_code == 200 and len(response.text) > 1000:
                # Check for SC
                if 'SC' in response.text[:5000]:
                    print(f"\n✓✓✓ REGION ID {region_id} RETURNS SC DATA ✓✓✓")
                    # Save sample
                    lines = response.text.split('\n')[:10]
                    for line in lines:
                        if ',SC,' in line:
                            print(f"  Sample: {line[:150]}...")
                            break
                else:
                    print(f"ID {region_id}: Returns data but not SC")
        except Exception as e:
            pass
        
        time.sleep(1)
