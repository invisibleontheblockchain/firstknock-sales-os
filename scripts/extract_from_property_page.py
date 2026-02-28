"""Try to extract region ID from a property page's HTML"""
import requests
import re
import json

# Use one of the property IDs we just found
property_id = "129324693"  # 102 Blossom Ct, Westminster, SC
url = f"https://www.redfin.com/SC/Westminster/102-Blossom-Ct-29693/home/{property_id}"

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
}

print(f"Fetching property page: {url}")
response = requests.get(url, headers=headers, timeout=30)
print(f"Status: {response.status_code}")

if response.status_code == 200:
    html = response.text
    
    # Try to find region information in the HTML
    print("\n" + "="*60)
    print("SEARCHING FOR REGION INFO IN HTML:")
    print("="*60)
    
    # Method 1: Look for regionId in the HTML
    region_patterns = [
        r'regionId["\']?\s*:\s*(\d+)',
        r'"regionId":\s*(\d+)',
        r'\"regionId\":\s*(\d+)',
        r'region["\']?\s*:\s*{[^}]*["\']?id["\']?\s*:\s*(\d+)',
    ]
    
    for pattern in region_patterns:
        matches = re.findall(pattern, html)
        if matches:
            print(f"\nPattern '{pattern}' found matches:")
            for match in set(matches[:5]):  # Show first 5 unique matches
                print(f"  Region ID: {match}")
    
    # Method 2: Look for window.__reactServerState or similar
    react_patterns = [
        r'window\.__reactServerState\s*=\s*({.+?});',
        r'window\.__data\s*=\s*({.+?});',
        r'renderContext\s*[=:]\s*({.+?})',
    ]
    
    print("\n" + "="*60)
    print("SEARCHING FOR REACT/DATA OBJECTS:")
    print("="*60)
    
    for pattern in react_patterns:
        matches = re.findall(pattern, html, re.DOTALL)
        if matches:
            print(f"\nFound data object with pattern: {pattern[:40]}...")
            # Try to parse and extract region info (safely)
            for match in matches[:1]:  # Just check first match
                try:
                    # Clean up the match
                    clean_match = match.replace('\\u0022', '"').replace('\\"', '"')
                    if len(clean_match) > 1000:  # Only show if substantial
                        print(f"  Data object length: {len(clean_match)} chars")
                        # Look for region info in the string
                        region_id_matches = re.findall(r'"regionId":(\d+)', clean_match)
                        if region_id_matches:
                            print(f"  Found regionIds: {set(region_id_matches[:10])}")
                except Exception as e:
                    print(f"  Error parsing: {e}")
    
    # Method 3: Look for Google Maps or similar embedded coordinates
    print("\n" + "="*60)
    print("SEARCHING FOR MAP/LOCATION DATA:")
    print("="*60)
    
    map_patterns = [
        r'"latitude":\s*([\d.-]+)',
        r'"longitude":\s*([\d.-]+)',
        r'center=([\d.-]+),\s*([\d.-]+)',
    ]
    
    for pattern in map_patterns:
        matches = re.findall(pattern, html)
        if matches:
            print(f"Found coordinates with pattern: {pattern[:40]}...")
            print(f"  Sample: {matches[:3]}")
    
    # Save a snippet of the HTML for manual inspection
    print("\n" + "="*60)
    print("HTML SNIPPET (first 5000 chars):")
    print("="*60)
    print(html[:5000])
