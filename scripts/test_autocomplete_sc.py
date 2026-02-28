import requests
import json

# Try the autocomplete API which may have less protection
queries = [
    "Anderson County, SC",
    "Oconee County, SC", 
    "Greenville County, SC",
    "29625",  # Anderson ZIP
    "29678",  # Seneca ZIP (Oconee)
    "29601",  # Greenville ZIP
]

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.redfin.com/',
    'X-RF-Stingray-Xhr': '1'
}

for query in queries:
    url = "https://www.redfin.com/stingray/do/location-autocomplete"
    params = {'location': query, 'v': '2'}
    
    print(f"\n{'='*60}")
    print(f"Query: {query}")
    print(f"{'='*60}")
    
    try:
        response = requests.get(url, params=params, headers=headers, timeout=15)
        print(f"Status: {response.status_code}")
        
        if response.status_code == 200:
            text = response.text
            if text.startswith('{}&&'):
                text = text[4:]
            
            data = json.loads(text)
            sections = data.get('payload', {}).get('sections', [])
            
            for section in sections:
                print(f"\nSection: {section.get('name')}")
                for row in section.get('rows', [])[:3]:  # First 3 results
                    print(f"  - {row.get('name')} | ID: {row.get('id')} | Type: {row.get('type')}")
        else:
            print(f"Error: {response.status_code}")
            print(response.text[:200])
            
    except Exception as e:
        print(f"Exception: {e}")
