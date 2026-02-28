import requests
import csv
import time

def test_direct_csv(region_id, region_type, name):
    session = requests.Session()
    # High-quality headers to look like a real browser
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.redfin.com/',
        'DNT': '1'
    })

    print(f"Advancing with direct CSV download for {name} (ID: {region_id}, Type: {region_type})...")
    
    # Try to prime session with the main site first
    try:
        session.get("https://www.redfin.com/", timeout=15)
        print("Primed session by visiting Redfin homepage.")
    except Exception as e:
        print(f"Warning: Failed to prime session: {e}")

    time.sleep(2)

    csv_url = "https://www.redfin.com/stingray/api/gis-csv"
    params = {
        'al': 1,
        'region_id': region_id,
        'region_type': region_type,
        'sold_within_days': 1825, # 5 years
        'status': '9', # Sold
        'v': 8
    }
    
    try:
        response = session.get(csv_url, params=params, timeout=45)
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            content = response.text
            print(f"Content length: {len(content)}")
            if len(content) > 100:
                print("Successfully retrieved data!")
                # Save a sample
                with open('oconee_sample.csv', 'w', encoding='utf-8') as f:
                    f.write(content)
                print("Saved to oconee_sample.csv")
                
                # Check headers
                reader = csv.DictReader(content.splitlines())
                first_row = next(reader, None)
                if first_row:
                    print("Found columns:", list(first_row.keys()))
            else:
                print("Content is too short, likely blocked or empty.")
                print(f"Content: {content}")
        elif response.status_code == 403:
            print("Access Forbidden (403). Redfin/CloudFront is blocking this request.")
        else:
            print(f"Unexpected status code: {response.status_code}")
            
    except Exception as e:
        print(f"Error during request: {e}")

if __name__ == "__main__":
    test_direct_csv('1722', '5', 'Oconee County, SC')
