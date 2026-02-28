import requests
import re
import sys

def extract_id(url):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Referer': 'https://www.redfin.com/',
    }
    
    print(f"Fetching {url}... ")
    try:
        response = requests.get(url, headers=headers, timeout=30)
        if response.status_code == 200:
            content = response.text
            # Look for "regionId":1234 or regionId: 1234 or "region_id":1234
            matches = re.findall(r'"regionId":\s*(\d+)', content)
            if not matches:
                matches = re.findall(r'regionId:\s*(\d+)', content)
            if not matches:
                matches = re.findall(r'"region_id":\s*(\d+)', content)
                
            if matches:
                print(f"Found IDs: {list(set(matches))}")
                # Filter out the 1802 if it's the URL ID
                return matches
            else:
                print("No regionId found in source.")
                # Print a bit of source to debug
                print(f"Content length: {len(content)}")
        else:
            print(f"Failed: {response.status_code}")
    except Exception as e:
        print(f"Error: {e}")
    return []

if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "https://www.redfin.com/county/1802/SC/Oconee-County"
    extract_id(url)
