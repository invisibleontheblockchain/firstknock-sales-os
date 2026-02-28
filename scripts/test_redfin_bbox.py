import requests
import csv
import argparse

def test_bbox(bbox, name):
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Referer': 'https://www.redfin.com/',
    })
    
    # Redfin bbox format is usually min_lat,min_long,max_lat,max_long
    # BUT sometimes it's different. Let's try boundary_rect.
    params = {
        'al': 1,
        'boundary_rect': bbox, # Format: min_lat,min_long,max_lat,max_long
        'sold_within_days': 1825,
        'status': '9', # Sold
        'v': 8
    }
    
    print(f"Testing bbox for {name} ({bbox})...")
    url = "https://www.redfin.com/stingray/api/gis-csv"
    
    try:
        response = session.get(url, params=params, timeout=30)
        if response.status_code == 200 and len(response.text) > 100:
            with open(f"test_bbox_{name.replace(' ', '_')}.csv", "w", encoding='utf-8') as f:
                f.write(response.text)
            
            reader = csv.DictReader(response.text.splitlines())
            count = 0
            first_row = None
            for row in reader:
                if count == 0:
                    first_row = row
                count += 1
            
            if first_row:
                addr = first_row.get('ADDRESS') or first_row.get('address')
                city = first_row.get('CITY') or first_row.get('city')
                state = first_row.get('STATE OR PROVINCE') or first_row.get('state')
                print(f"SUCCESS! Found {count} properties.")
                print(f"Sample: {addr}, {city}, {state}")
            else:
                print("SUCCESS but empty or headers only.")
        else:
            print(f"FAILED: Status {response.status_code}, Length {len(response.text)}")
    except Exception as e:
        print(f"ERROR: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    
    test_bbox(args.bbox, args.name)
