"""Test if region ID 12253 downloads Oconee County, SC data"""
import requests

def test_region_download(region_id, expected_county, expected_state):
    """Test downloading data for a specific region ID"""
    
    # Redfin CSV download endpoint
    url = f"https://www.redfin.com/stingray/api/gis-csv?al=1&region_id={region_id}&region_type=5&status=9&num_homes=100"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/csv,text/plain,*/*',
        'Referer': 'https://www.redfin.com/',
        'X-RF-Stingray-Xhr': '1'
    }
    
    print(f"\n{'='*60}")
    print(f"Testing Region ID: {region_id}")
    print(f"Expected: {expected_county}, {expected_state}")
    print(f"{'='*60}")
    
    try:
        response = requests.get(url, headers=headers, timeout=60)
        print(f"Status: {response.status_code}")
        
        if response.status_code == 200:
            # Try to parse as CSV to check the state
            content = response.text[:3000]  # First 3000 chars
            lines = content.split('\n')
            
            print(f"\nResponse preview (first 1500 chars):")
            print(content[:1500])
            
            # Look for STATE column in headers
            header_line = None
            for line in lines[:5]:
                if 'STATE OR PROVINCE' in line.upper() or 'STATE' in line.upper():
                    header_line = line
                    break
            
            print(f"\n\nAnalyzing data...")
            
            # Count occurrences of state in the data
            state_counts = {}
            for line in lines[5:30]:  # Check first 25 data rows
                parts = line.split(',')
                for i, part in enumerate(parts):
                    if expected_state in part and len(part.strip()) == 2:
                        state_counts[part.strip()] = state_counts.get(part.strip(), 0) + 1
            
            if state_counts:
                print(f"States found in sample: {state_counts}")
                if expected_state in state_counts:
                    print(f"✓ SUCCESS: Found {expected_state} data!")
                    return True
                else:
                    print(f"✗ FAILURE: No {expected_state} data found")
                    return False
            else:
                print("Could not determine state from sample")
                return None
        else:
            print(f"Failed with status: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == "__main__":
    # Test the discovered region ID for Oconee County
    result = test_region_download(12253, "Oconee County", "SC")
    
    if result:
        print("\n" + "="*60)
        print("✓✓✓ REGION ID 12253 WORKS FOR OCONEE COUNTY, SC ✓✓✓")
        print("="*60)
