import requests
import re
import json

def extract_from_url(url):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.google.com/'
    }
    
    print(f"Fetching {url}...")
    try:
        response = requests.get(url, headers=headers, timeout=30)
        if response.status_code == 200:
            html = response.text
            
            # Look for regionId in the HTML
            # Common patterns:
            # "regionId":1234
            # regionId=1234
            # "primaryRegionId":1234
            
            matches = re.findall(r'"regionId":(\d+)', html)
            print(f"Found regionId matches: {list(set(matches))}")
            
            # Look for context JSON
            context_match = re.search(r'root.renderContext = (.*?);', html)
            if context_match:
                print("Found renderContext!")
                # We could parse this as JSON to be more precise
            
            # Look for "Oconee" specifically near a regionId
            oconee_match = re.search(r'Oconee.*?regionId":(\d+)', html, re.IGNORECASE | re.DOTALL)
            if oconee_match:
                print(f"Potential Oconee Region ID: {oconee_match.group(1)}")
            
            with open('property_page_sample.html', 'w', encoding='utf-8') as f:
                f.write(html)
            
            return list(set(matches))
        else:
            print(f"Failed with status: {response.status_code}")
            return []
    except Exception as e:
        print(f"Error: {e}")
        return []

if __name__ == "__main__":
    # Seneca, SC (Oconee County)
    extract_from_url("https://www.redfin.com/SC/Seneca/117-Harbin-Acres-Rd-29672/home/129462194")
