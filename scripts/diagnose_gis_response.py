"""Diagnose the GIS API response structure"""
import requests
import json

url = "https://www.redfin.com/stingray/api/gis"

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.redfin.com/',
    'X-RF-Stingray-Xhr': '1'
}

# Oconee County Box
poly = "-83.15 34.50,-82.80 34.50,-82.80 34.95,-83.15 34.95,-83.15 34.50"

params = {
    'al': 1,
    'poly': poly,
    'status': 9,
    'num_homes': 10,
    'v': 8
}

response = requests.get(url, params=params, headers=headers, timeout=30)
print(f"Status: {response.status_code}")

if response.status_code == 200:
    content = response.text
    if content.startswith("{}&&"):
        content = content[4:]
    
    data = json.loads(content)
    
    print("\n" + "="*60)
    print("FULL RESPONSE STRUCTURE:")
    print("="*60)
    print(json.dumps(data, indent=2)[:3000])  # Print first 3000 chars
    
    # Look for region information in various places
    payload = data.get('payload', {})
    
    print("\n" + "="*60)
    print("PAYLOAD KEYS:", list(payload.keys()))
    print("="*60)
    
    # Check for region info
    print("\n--- regionId ---")
    print(f"regionId in payload: {payload.get('regionId')}")
    
    print("\n--- regionType ---")
    print(f"regionType in payload: {payload.get('regionType')}")
    
    print("\n--- title ---")
    print(f"title in payload: {payload.get('title')}")
    
    # Check homes for their location
    print("\n--- Sample homes ---")
    homes = payload.get('homes', [])
    if homes:
        for i, home in enumerate(homes[:3]):
            print(f"\nHome {i+1}:")
            print(f"  Address: {home.get('address')}")
            print(f"  State: {home.get('state')}")
            print(f"  City: {home.get('city')}")
            print(f"  ZIP: {home.get('zip')}")
            
            # Check if there's region info in the home
            if 'regionId' in home:
                print(f"  Region ID: {home.get('regionId')}")
            if 'regionType' in home:
                print(f"  Region Type: {home.get('regionType')}")
