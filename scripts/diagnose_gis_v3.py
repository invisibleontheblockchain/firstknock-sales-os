"""Diagnose the GIS API with CORRECT Oconee County, SC coordinates"""
import requests
import json

url = "https://www.redfin.com/stingray/api/gis"

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.redfin.com/',
    'X-RF-Stingray-Xhr': '1'
}

# CORRECT Oconee County, SC bounding box
# Seneca, SC (county seat): ~34.68°N, 82.95°W  -> in poly format: -82.95 34.68
# Walhalla, SC: ~34.77°N, 83.07°W -> in poly format: -83.07 34.77
# West Union, SC: ~34.76°N, 83.04°W -> in poly format: -83.04 34.76
# 
# Bounding box for Oconee County, SC:
# West: -83.15 (Walhalla/West Union area)  
# East: -82.80 (Lake Hartwell/Seneca area)
# South: 34.60 (southern county line)
# North: 34.90 (northern county line/near NC border)
# Note: format is "longitude latitude"

oconee_poly = "-83.15 34.60,-82.80 34.60,-82.80 34.90,-83.15 34.90,-83.15 34.60"

print(f"Testing Oconee County, SC with poly: {oconee_poly}")
print("Expected: City=Seneca or Walhalla, State=SC")

params = {
    'al': 1,
    'poly': oconee_poly,
    'status': 9,  # Sold
    'num_homes': 10,
    'v': 8
}

response = requests.get(url, params=params, headers=headers, timeout=30)
print(f"\nStatus: {response.status_code}")

if response.status_code == 200:
    content = response.text
    if content.startswith("{}&&"):
        content = content[4:]
    
    data = json.loads(content)
    payload = data.get('payload', {})
    
    print(f"\nserviceRegionName: {payload.get('serviceRegionName')}")
    
    homes = payload.get('homes', [])
    print(f"\nNumber of homes returned: {len(homes)}")
    
    if homes:
        print("\n--- First 5 homes ---")
        for i, home in enumerate(homes[:5]):
            print(f"\nHome {i+1}:")
            print(f"  City: {home.get('city')}, State: {home.get('state')}")
            print(f"  Address: {home.get('streetLine', {}).get('value')}")
            print(f"  URL: {home.get('url')}")
