import requests
import io
import pandas as pd
import time

def test_id(id, rtype, label):
    url = "https://www.redfin.com/stingray/api/gis-csv"
    params = {
        'al': 1,
        'region_id': id,
        'region_type': rtype,
        'status': 9, # Sold
        'num_homes': 5
    }
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    }
    
    print(f"Testing {label} | ID: {id} | Type: {rtype}...")
    try:
        response = requests.get(url, params=params, headers=headers, timeout=15)
        if response.status_code == 200:
            df = pd.read_csv(io.StringIO(response.text))
            if not df.empty:
                city = df['CITY'].iloc[0]
                state = df['STATE OR PROVINCE'].iloc[0]
                print(f"  SUCCESS: Found data for {city}, {state}")
                return city, state
            else:
                print("  EMPTY: No data returned.")
        else:
            print(f"  FAILED: Status {response.status_code}")
    except Exception as e:
        print(f"  ERROR: {e}")
    return None, None

if __name__ == "__main__":
    tests = [
        (1381, 5, "Greenville URL ID"),
        (2513, 5, "Oconee URL ID"),
        (2514, 5, "Anderson URL ID"),
        (37792, 5, "Guess 1"),
        (10688, 5, "Guess 2"),
        (51, 4, "Greenville Metro ID"),
        (1322, 5, "Guess 3"),
        (1802, 5, "Original Failed Oconee ID"),
        (1721, 5, "Original Failed Greenville ID"),
        (1715, 5, "Original Failed Anderson ID"),
    ]
    
    for rid, rtype, label in tests:
        test_id(rid, rtype, label)
        time.sleep(1)
