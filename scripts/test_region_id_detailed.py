"""Test if region ID 12253 downloads Oconee County, SC data - detailed view"""
import requests
import csv
import io

def test_region_download(region_id):
    """Test downloading data for a specific region ID"""
    
    # Redfin CSV download endpoint
    url = f"https://www.redfin.com/stingray/api/gis-csv?al=1&region_id={region_id}&region_type=5&status=9&num_homes=100"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/csv,text/plain,*/*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    print(f"Testing Region ID: {region_id}")
    
    try:
        response = requests.get(url, headers=headers, timeout=60)
        print(f"Status: {response.status_code}")
        print(f"Content-Type: {response.headers.get('Content-Type', 'unknown')}")
        print(f"Content length: {len(response.text)} chars")
        
        if response.status_code == 200:
            # Parse as CSV
            try:
                csv_data = list(csv.reader(io.StringIO(response.text)))
                
                print(f"\nTotal rows: {len(csv_data)}")
                
                if len(csv_data) > 0:
                    # Find STATE column
                    header = csv_data[0]
                    state_idx = None
                    city_idx = None
                    
                    for i, col in enumerate(header):
                        if 'STATE' in col.upper():
                            state_idx = i
                            print(f"Found STATE column at index {i}: '{col}'")
                        if 'CITY' in col.upper():
                            city_idx = i
                            print(f"Found CITY column at index {i}: '{col}'")
                    
                    # Analyze states
                    states = {}
                    cities = {}
                    for row in csv_data[3:]:  # Skip headers and disclaimers
                        if len(row) > max(state_idx or 0, city_idx or 0):
                            if state_idx is not None:
                                state = row[state_idx].strip()
                                if state:
                                    states[state] = states.get(state, 0) + 1
                            if city_idx is not None:
                                city = row[city_idx].strip()
                                if city:
                                    cities[city] = cities.get(city, 0) + 1
                    
                    print(f"\nStates found in data: {states}")
                    print(f"Cities found: {list(cities.keys())[:10]}")
                    
                    if 'SC' in states:
                        print(f"\n✓✓✓ SUCCESS! Found SC data with region ID {region_id}")
                        return True
                    elif states:
                        print(f"\n✗✗✗ Found data but NOT from SC. States: {states}")
                        return False
                    else:
                        print("\nNo data rows found (only headers)")
                        return None
                        
            except Exception as e:
                print(f"Error parsing CSV: {e}")
                print(f"\nRaw content preview:\n{response.text[:2000]}")
                return None
        else:
            print(f"Failed: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == "__main__":
    # Test the discovered region ID
    result = test_region_download(12253)
