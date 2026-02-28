import requests
import json
import time
import random
import csv

def get_region_id_from_property(property_id):
    url = f"https://www.redfin.com/stingray/api/home/details/aboveTheFold?propertyId={property_id}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.redfin.com/',
    }

    try:
        print(f"Requesting metadata for property {property_id}...")
        response = requests.get(url, headers=headers, timeout=30)
        if response.status_code == 200:
            # The response usually starts with {}&&
            content = response.text
            if content.startswith("{}&&"):
                content = content[4:]
            
            data = json.loads(content)
            # Standard path: payload -> propertyRegionInfo -> primaryRegionId
            # Sometimes it's in payload -> propertyInfo -> regionId
            payload = data.get('payload', {})
            region_info = payload.get('propertyRegionInfo', {})
            
            regions = {}
            if region_info:
                # Region Type 5 is County
                # Region Type 6 is Zip
                # Region Type 2 is City
                for r in region_info.get('regions', []):
                    regions[r.get('type')] = {
                        'id': r.get('id'),
                        'name': r.get('name')
                    }
            
            return {
                'success': True,
                'regions': regions,
                'city': payload.get('addressInfo', {}).get('city'),
                'state': payload.get('addressInfo', {}).get('state'),
                'zip': payload.get('addressInfo', {}).get('zip')
            }
        else:
            return {'success': False, 'status': response.status_code}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def main():
    # Load sample properties from the cleaned JSON
    json_path = r'c:\Users\avion\OneDrive\Documents\GitHub\ghosteam\ghosteam-v5\firstknock-sales-os\tricounty_sold_properties_cleaned.json'
    
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            properties = json.load(f)
    except Exception as e:
        print(f"Error loading JSON: {e}")
        return

    # Group by county source to get one sample each
    samples = {}
    for p in properties:
        cs = p.get('County_Source', 'Unknown')
        if cs not in samples and 'URL' in str(p.keys()): # Handle variations
            url_key = [k for k in p.keys() if 'URL' in k][0]
            url = p[url_key]
            if '/home/' in url:
                prop_id = url.split('/home/')[-1].split('?')[0]
                samples[cs] = prop_id

    print(f"Found sample property IDs for counties: {list(samples.keys())}")
    
    results = {}
    for county, prop_id in samples.items():
        print(f"\nProcessing {county} (Sample Prop ID: {prop_id})...")
        res = get_region_id_from_property(prop_id)
        if res['success']:
            print(f"Verified Location: {res['city']}, {res['state']} {res['zip']}")
            print(f"Regions Found: {res['regions']}")
            results[county] = res['regions']
        else:
            print(f"Failed to get data for {county}: {res.get('status') or res.get('error')}")
        
        # Sleep to avoid immediate block
        time.sleep(random.uniform(5, 10))

    with open('scripts/sc_region_id_mapping.json', 'w') as f:
        json.dump(results, f, indent=4)
    print("\nResults saved to scripts/sc_region_id_mapping.json")

if __name__ == "__main__":
    main()
