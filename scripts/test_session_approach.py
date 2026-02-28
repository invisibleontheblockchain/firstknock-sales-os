import requests
import json
import time

# Create a session that maintains cookies
session = requests.Session()

# First, visit the main Redfin page to get cookies
print("Step 1: Visiting Redfin homepage to get cookies...")
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
})

try:
    home_resp = session.get('https://www.redfin.com/', timeout=15)
    print(f"Homepage status: {home_resp.status_code}")
    print(f"Cookies received: {dict(session.cookies)}")
    
    # Wait a bit
    time.sleep(2)
    
    # Now try the autocomplete API
    print("\nStep 2: Trying autocomplete API...")
    session.headers.update({
        'X-RF-Stingray-Xhr': '1',
        'Referer': 'https://www.redfin.com/',
    })
    
    url = "https://www.redfin.com/stingray/do/location-autocomplete"
    params = {'location': 'Anderson County, SC', 'v': '2'}
    
    response = session.get(url, params=params, timeout=15)
    print(f"Autocomplete status: {response.status_code}")
    
    if response.status_code == 200:
        text = response.text
        if text.startswith('{}&&'):
            text = text[4:]
        
        data = json.loads(text)
        sections = data.get('payload', {}).get('sections', [])
        
        print(f"\nFound {len(sections)} sections:")
        for section in sections:
            print(f"\n{section.get('name')}:")
            for row in section.get('rows', [])[:3]:
                print(f"  - {row.get('name')} (ID: {row.get('id')}, Type: {row.get('type')})")
    else:
        print(f"Failed: {response.text[:300]}")
        
except Exception as e:
    print(f"Error: {e}")
