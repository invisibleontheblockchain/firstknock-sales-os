"""Test region ID 12253 with correct parameters matching the scraper"""
import requests
import csv
import io

def test_region_download(region_id, days=1825):
    """Test downloading data with correct parameters"""
    
    # Match the scraper's URL and parameters exactly
    url = "https://www.redfin.com/stingray/api/gis-csv"
    
    # Match scraper parameters
    params = {
        'al': 1,
        'region_id': region_id,
        'region_type': 5,  # County
        'sold_within_days': days,
        'status': '9',  # String like scraper uses
        'v': 8
    }
    
    # Match scraper headers
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'X-RF-Stingray-Xhr': '1',
        'Referer': 'https://www.redfin.com/',
    }
    
    # Use a session like the scraper
    session = requests.Session()
    session.headers.update(headers)
    
    # Prime the session (like scraper does)
    print("Priming session...")
    session.get("https://www.redfin.com/", timeout=15)
    
    print(f"\nTesting Region ID: {region_id}")
    print(f"URL: {url}")
    print(f"Params: {params}")
    
    try:
        response = session.get(url, params=params, timeout=60)
        print(f"Status: {response.status_code}")
        print(f"Content length: {len(response.text)} chars")
        
        if response.status_code == 200 and len(response.text) > 500:
            # Parse CSV
            try:
                csv_data = list(csv.reader(io.StringIO(response.text)))
                print(f"CSV rows: {len(csv_data)}")
                
                if len(csv_data) > 5:  # Has headers + data
                    header = csv_data[0]
                    
                    # Find state column
                    state_idx = None
                    for i, col in enumerate(header):
                        if 'STATE' in col.upper():
                            state_idx = i
                            break
                    
                    # Collect states
                    states = {}
                    for row in csv_data[3:]:
                        if len(row) > state_idx:
                            state = row[state_idx].strip()
                            if state and len(state) == 2:
                                states[state] = states.get(state, 0) + 1
                    
                    print(f"\nStates found: {states}")
                    
                    if 'SC' in states:
                        print(f"\n✓✓✓ SUCCESS! Region ID {region_id} returns SC data!")
                        return True
                    else:
                        print(f"\n✗ Wrong state data: {states}")
                        return False
                else:
                    print("No data rows found")
                    return None
                    
            except Exception as e:
                print(f"CSV parse error: {e}")
                return None
        else:
            print(f"Failed or empty response")
            print(f"Response preview: {response.text[:500]}")
            return False
            
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == "__main__":
    # Test the discovered region ID 12253
    result = test_region_download(12253)
