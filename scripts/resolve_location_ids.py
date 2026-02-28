import requests
import json
import time

def resolve_location(query):
    url = "https://www.redfin.com/stingray/do/location-autocomplete"
    params = {'location': query, 'v': '2'}
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    print(f"Resolving location for: {query}")
    try:
        response = requests.get(url, params=params, headers=headers, timeout=15)
        print(f"Status: {response.status_code}")
        
        text = response.text
        if text.startswith('{}&&'):
            text = text[4:]
        
        data = json.loads(text)
        payload = data.get('payload', [])
        
        for item in payload:
            name = item.get('name')
            subname = item.get('subName')
            id = item.get('id')
            type = item.get('type')
            print(f"  MATCH: {name} | {subname} | ID: {id} | Type: {type}")
            
        return payload
    except Exception as e:
        print(f"Error: {e}")
        return []

if __name__ == "__main__":
    queries = [
        "29678", # Seneca (Oconee)
        "29601", # Greenville
        "29621"  # Anderson
    ]
    
    all_results = {}
    for q in queries:
        all_results[q] = resolve_location(q)
        time.sleep(2)
        
    with open('scripts/location_resolution_results.json', 'w') as f:
        json.dump(all_results, f, indent=4)
