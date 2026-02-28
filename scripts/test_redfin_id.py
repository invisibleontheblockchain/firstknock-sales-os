import requests
import csv
import argparse
import time

def test_id(region_id, region_type, name):
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    })
    
    params = {
        'al': 1,
        'region_id': region_id,
        'region_type': region_type,
        'sold_within_days': 1825,
        'status': '9',
        'v': 8
    }
    
    print(f"Testing {name} (ID: {region_id}, Type: {region_type})...")
    url = "https://www.redfin.com/stingray/api/gis-csv"
    
    try:
        response = session.get(url, params=params, timeout=30)
        if response.status_code == 200 and len(response.text) > 100:
            with open(f"test_id_{region_id}.csv", "w", encoding='utf-8') as f:
                f.write(response.text)
            
            reader = csv.DictReader(response.text.splitlines())
            first_row = next(reader, None)
            if first_row:
                print(f"Headers: {list(first_row.keys())[:10]}...")
                # Redfin CSV headers are usually capitalized
                addr = first_row.get('ADDRESS') or first_row.get('address')
                city = first_row.get('CITY') or first_row.get('city')
                state = first_row.get('STATE OR PROVINCE') or first_row.get('state')
                zip_code = first_row.get('ZIP OR POSTAL CODE') or first_row.get('zip')
                
                print(f"SUCCESS! Found property: {addr}, {city}, {state} {zip_code}")
                # Print coordinates to be sure
                lat = first_row.get('LATITUDE')
                lon = first_row.get('LONGITUDE')
                print(f"Coordinates: {lat}, {lon}")
            else:
                print("SUCCESS (status 200) but no rows found (likely just headers).")
                print(f"Content: {response.text[:200]}")
        else:
            print(f"FAILED: Status {response.status_code}, Length {len(response.text)}")
    except Exception as e:
        print(f"ERROR: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    parser.add_argument("--type", required=True)
    parser.add_argument("--name", default="Unknown")
    args = parser.parse_args()
    
    test_id(args.id, args.type, args.name)
