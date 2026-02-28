import requests
import json
import time

def get_region_metadata(poly_str, name):
    url = "https://www.redfin.com/stingray/api/gis"
    params = {
        'al': 1,
        'poly': poly_str,
        'status': 9, # Sold
        'num_homes': 1,
        'v': 8
    }
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    print(f"Querying Redfin for {name} tiny box...")
    try:
        response = requests.get(url, params=params, headers=headers, timeout=30)
        print(f"Status: {response.status_code}")
        
        text = response.text
        if text.startswith('{}&&'):
            text = text[4:]
        
        data = json.loads(text)
        payload = data.get('payload', {})
        homes = payload.get('homes', [])
        
        if homes:
            home = homes[0]
            print(f"Found home: {home.get('streetLine', {}).get('value')}")
            print(f"URL: {home.get('url')}")
            # If we find a home, we can try to get its details or look for other fields
            
        with open(f'scripts/{name.lower()}_micro_payload.json', 'w') as f:
            json.dump(data, f, indent=4)
            
        return homes
    except Exception as e:
        print(f"Error: {e}")
        return []

if __name__ == "__main__":
    # Anderson SC Micro Box around Bristol Ct
    anderson_micro = "-82.70 34.53,-82.68 34.53,-82.68 34.55,-82.70 34.55,-82.70 34.53"
    
    get_region_metadata(anderson_micro, "Anderson")
