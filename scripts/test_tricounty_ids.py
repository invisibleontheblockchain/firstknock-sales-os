import requests
import csv
import time

def test_direct_csv(region_id, region_type, name):
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.redfin.com/',
    })

    print(f"Testing direct CSV for {name} (ID: {region_id}, Type: {region_type})...")
    
    csv_url = "https://www.redfin.com/stingray/api/gis-csv"
    params = {
        'al': 1,
        'region_id': region_id,
        'region_type': region_type,
        'sold_within_days': 1825,
        'status': '9',
        'v': 8
    }
    
    try:
        response = session.get(csv_url, params=params, timeout=45)
        if response.status_code == 200 and len(response.text) > 100:
            print(f"SUCCESS: Retrieved data for {name}")
            reader = csv.DictReader(response.text.splitlines())
            first_row = next(reader, None)
            if first_row:
                print(f"Sample Address: {first_row.get('ADDRESS')}, {first_row.get('CITY')}, {first_row.get('STATE OR PROVINCE')}")
            
            with open(f'test_{region_id}.csv', 'w', encoding='utf-8') as f:
                f.write(response.text)
        else:
            print(f"FAILED: Status {response.status_code}, Length {len(response.text)}")
    except Exception as e:
        print(f"ERROR: {e}")

if __name__ == "__main__":
    test_direct_csv('1802', '5', 'Oconee SC')
    time.sleep(2)
    test_direct_csv('1721', '5', 'Greenville SC')
    time.sleep(2)
    test_direct_csv('1715', '5', 'Anderson SC')
