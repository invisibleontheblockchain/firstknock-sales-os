import requests
import json
import re

def generate_county_json():
    url = "https://www2.census.gov/geo/docs/reference/codes/files/national_county.txt"
    response = requests.get(url)
    if response.status_code != 200:
        print(f"Failed to fetch data: {response.status_code}")
        return

    lines = response.text.strip().split('\n')
    counties_by_state = {}

    for line in lines:
        parts = line.split(',')
        if len(parts) >= 4:
            state = parts[0].strip()
            county_full = parts[3].strip()
            
            # Remove " County", " Parish", " Borough", " Census Area", " Municipality", etc.
            # But the scraper script adds " County" back in its search queries.
            # Let's see how Redfin handles it.
            # Actually, keeping the full name might be safer, and we can trim it if search fails.
            # But "Autauga County County" is definitely wrong.
            # Let's strip the suffix.
            county_name = re.sub(r'\s+(County|Parish|Borough|Census Area|Municipality|City and Borough|City)$', '', county_full, flags=re.IGNORECASE)
            
            if state not in counties_by_state:
                counties_by_state[state] = []
            counties_by_state[state].append(county_name)

    data = {"counties_by_state": counties_by_state}
    
    with open('us_counties_complete.json', 'w') as f:
        json.dump(data, f, indent=2)
    
    print(f"Generated us_counties_complete.json with {sum(len(v) for v in counties_by_state.values())} counties.")

if __name__ == "__main__":
    generate_county_json()
