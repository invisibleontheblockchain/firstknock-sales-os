import requests
import json

property_id = '86687783'
url = f'https://www.redfin.com/stingray/api/home/details/aboveTheFold?propertyId={property_id}'
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.redfin.com/',
}

print(f'Testing API for property {property_id}...')
response = requests.get(url, headers=headers, timeout=30)
print(f'Status: {response.status_code}')
print(f'Content length: {len(response.text)}')

if response.status_code == 200:
    content = response.text
    if content.startswith('{}&&'):
        content = content[4:]
    data = json.loads(content)
    payload = data.get('payload', {})
    region_info = payload.get('propertyRegionInfo', {})
    print(f'\nRegions found:')
    for r in region_info.get('regions', []):
        print(f'  Type {r.get("type")}: {r.get("name")} (ID: {r.get("id")})')
else:
    print(f'Response: {response.text[:500]}')
