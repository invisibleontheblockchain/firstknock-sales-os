"""Diagnose the GIS API with correct SC coordinates"""
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
# Longitudes should be around -83.0 (not -83.15)
oconee_poly = "-83.20 34.55,-82.85 34.55,-82.85 34.95,-83.20 34.95,-83.20 34.55"

params = {
    'al': 1,
    'poly': oconee_poly,
    'status': 9,  # Sold
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
    payload = data.get('payload', {})
    
    print("\n" + "="*60)
    print("NON-HOME PAYLOAD KEYS:")
    print("="*60)
    for key in payload.keys():
        if key != 'homes' and key != 'dataSources':
            print(f"\n{key}:")
            value = payload[key]
            if isinstance(value, (str, int, float)):
                print(f"  {value}")
            else:
                print(f"  (type: {type(value).__name__})")
                if isinstance(value, dict):
                    print(json.dumps(value, indent=2))
    
    print("\n" + "="*60)
    print("SAMPLE HOMES (States):")
    print("="*60)
    homes = payload.get('homes', [])
    states = set()
    cities = set()
    for home in homes:
        states.add(home.get('state'))
        cities.add(home.get('city'))
    
    print(f"States found: {states}")
    print(f"Cities found: {cities}")
