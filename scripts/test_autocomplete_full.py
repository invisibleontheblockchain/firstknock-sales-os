import requests
import json
import time

session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.redfin.com/',
})

def test_autocomplete(query):
    url = "https://www.redfin.com/stingray/do/location-autocomplete"
    params = {'location': query, 'v': '2'}
    
    print(f"Testing autocomplete for: {query}")
    try:
        response = session.get(url, params=params, timeout=15)
        print(f"Status: {response.status_code}")
        with open('blocking_page.html', 'w', encoding='utf-8') as f:
            f.write(response.text)
        print(f"Saved response to blocking_page.html")
                
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_autocomplete("Oconee County, SC")
