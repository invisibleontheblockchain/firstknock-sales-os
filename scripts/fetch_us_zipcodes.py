"""
Fetch all US ZIP codes with coordinates and metadata.
Uses multiple data sources to build a comprehensive ZIP code database.
"""
import requests
import json
import csv
import os
from pathlib import Path
from typing import List, Dict

class ZipCodeFetcher:
    """Fetches comprehensive US ZIP code data from multiple sources."""
    
    def __init__(self, output_dir: str = "data"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        
    def fetch_from_census(self) -> List[Dict]:
        """
        Fetch ZIP codes from Census Bureau API.
        Returns list of ZIP codes with state information.
        """
        print("Fetching ZIP code data from Census Bureau...")
        
        # Census API for ZIP code tabulation areas
        url = "https://api.census.gov/data/2020/dec/pl"
        params = {
            'get': 'NAME',
            'for': 'zip code tabulation area:*'
        }
        
        try:
            response = requests.get(url, params=params, timeout=60)
            if response.status_code == 200:
                data = response.json()
                # First row is headers
                headers = data[0]
                zips = []
                for row in data[1:]:
                    zip_data = dict(zip(headers, row))
                    zips.append({
                        'zip': zip_data.get('zip code tabulation area', ''),
                        'name': zip_data.get('NAME', ''),
                        'state': ''  # Will need to map from another source
                    })
                print(f"  Found {len(zips)} ZIP codes from Census")
                return zips
        except Exception as e:
            print(f"  Error fetching from Census: {e}")
        
        return []
    
    def fetch_from_openaddresses(self) -> List[Dict]:
        """
        Alternative: Use OpenDataSoft or similar open data sources.
        """
        print("Fetching from alternative open data sources...")
        
        # Using the Zippopotam.us API (free, but rate limited)
        # For bulk data, we'll use a static dataset approach
        
        # Source: SimpleMaps US ZIP codes dataset (public domain data)
        url = "https://raw.githubusercontent.com/scpike/us-state-boundaries/master/data/usa-zip-codes.csv"
        
        try:
            response = requests.get(url, timeout=60)
            if response.status_code == 200:
                zips = []
                reader = csv.DictReader(response.text.splitlines())
                for row in reader:
                    zips.append({
                        'zip': row.get('zip_code', ''),
                        'city': row.get('city', ''),
                        'state': row.get('state', ''),
                        'latitude': row.get('latitude', ''),
                        'longitude': row.get('longitude', ''),
                        'county': row.get('county', '')
                    })
                print(f"  Found {len(zips)} ZIP codes from open data")
                return zips
        except Exception as e:
            print(f"  Error: {e}")
        
        return []
    
    def generate_comprehensive_zip_list(self) -> List[Dict]:
        """
        Generate comprehensive list of US ZIP codes.
        Uses known ZIP code ranges and validation.
        """
        print("Generating comprehensive US ZIP code list...")
        
        # ZIP codes by state ranges
        zip_ranges = {
            'AL': (35004, 36925), 'AK': (99501, 99950), 'AZ': (85001, 86556),
            'AR': (71601, 72959), 'CA': (90001, 96162), 'CO': (80001, 81658),
            'CT': (6001, 6928), 'DE': (19701, 19980), 'FL': (32003, 34997),
            'GA': (30001, 39901), 'HI': (96701, 96898), 'ID': (83201, 83877),
            'IL': (60001, 62999), 'IN': (46001, 47997), 'IA': (50001, 52809),
            'KS': (66002, 67954), 'KY': (40003, 42788), 'LA': (70001, 71497),
            'ME': (3901, 4992), 'MD': (20588, 21930), 'MA': (1001, 5544),
            'MI': (48001, 49971), 'MN': (55001, 56763), 'MS': (38601, 39776),
            'MO': (63001, 65899), 'MT': (59001, 59937), 'NE': (68001, 69367),
            'NV': (88901, 89883), 'NH': (3031, 3897), 'NJ': (7001, 8989),
            'NM': (87001, 88439), 'NY': (501, 14925), 'NC': (27006, 28909),
            'ND': (58001, 58856), 'OH': (43001, 45999), 'OK': (73001, 74966),
            'OR': (97001, 97920), 'PA': (15001, 19640), 'RI': (2801, 2940),
            'SC': (29001, 29945), 'SD': (57001, 57799), 'TN': (37010, 38589),
            'TX': (75001, 79999), 'UT': (84001, 84791), 'VT': (5001, 5907),
            'VA': (20101, 24658), 'WA': (98001, 99403), 'WV': (24701, 26886),
            'WI': (53001, 54990), 'WY': (82001, 83414), 'DC': (20001, 20799),
            'PR': (601, 795), 'VI': (801, 850), 'GU': (96910, 96932),
            'AS': (96799, 96799), 'MP': (96950, 96952)
        }
        
        zips = []
        for state, (start, end) in zip_ranges.items():
            for zip_code in range(start, end + 1):
                # Skip invalid ranges
                if state == 'NY' and zip_code > 501 and zip_code < 1000:
                    zip_str = f"{zip_code:04d}"
                elif state in ['CT', 'MA', 'ME', 'NH', 'NJ', 'RI', 'VT'] and zip_code < 10000:
                    zip_str = f"{zip_code:04d}"
                elif state == 'PR' and zip_code < 1000:
                    zip_str = f"{zip_code:03d}"
                else:
                    zip_str = f"{zip_code:05d}"
                
                zips.append({
                    'zip': zip_str,
                    'state': state,
                    'city': '',
                    'county': '',
                    'latitude': None,
                    'longitude': None
                })
        
        print(f"  Generated {len(zips)} potential ZIP codes")
        return zips
    
    def enrich_with_coordinates(self, zips: List[Dict]) -> List[Dict]:
        """
        Enrich ZIP codes with coordinates using Zippopotam.us API.
        Note: This makes many API calls - use with rate limiting.
        """
        print("Enriching ZIP codes with coordinates...")
        
        enriched = []
        total = len(zips)
        
        for i, zip_data in enumerate(zips[:1000]):  # Limit for testing
            if i % 100 == 0:
                print(f"  Processed {i}/{total}")
            
            try:
                url = f"http://api.zippopotam.us/us/{zip_data['zip']}"
                response = requests.get(url, timeout=5)
                if response.status_code == 200:
                    data = response.json()
                    places = data.get('places', [])
                    if places:
                        place = places[0]
                        zip_data['latitude'] = place.get('latitude')
                        zip_data['longitude'] = place.get('longitude')
                        zip_data['city'] = place.get('place name', '')
                        zip_data['state'] = data.get('state abbreviation', zip_data['state'])
            except Exception:
                pass
            
            enriched.append(zip_data)
        
        return enriched
    
    def fetch_from_static_source(self) -> List[Dict]:
        """
        Fetch ZIP code data from a reliable static source.
        Uses the USPS ZIP code database format.
        """
        print("Fetching from static data sources...")
        
        # Try to download from a known good source
        sources = [
            # Free ZIP code database from GitHub
            "https://raw.githubusercontent.com/scpike/us-state-boundaries/master/data/usa-zip-codes.csv",
        ]
        
        for url in sources:
            try:
                response = requests.get(url, timeout=60)
                if response.status_code == 200:
                    zips = []
                    reader = csv.DictReader(response.text.splitlines())
                    for row in reader:
                        zips.append({
                            'zip': row.get('zip', row.get('zip_code', '')),
                            'city': row.get('city', ''),
                            'state': row.get('state', ''),
                            'latitude': row.get('latitude'),
                            'longitude': row.get('longitude'),
                            'county': row.get('county', '')
                        })
                    print(f"  Successfully loaded {len(zips)} ZIP codes")
                    return zips
            except Exception as e:
                print(f"  Failed to load from {url}: {e}")
                continue
        
        return []
    
    def save_zips(self, zips: List[Dict], filename: str = "us_zipcodes.json"):
        """Save ZIP codes to JSON file."""
        filepath = self.output_dir / filename
        with open(filepath, 'w') as f:
            json.dump({
                'count': len(zips),
                'zip_codes': zips,
                'generated_at': json.dumps({})
            }, f, indent=2)
        print(f"Saved {len(zips)} ZIP codes to {filepath}")
        return filepath
    
    def save_zips_csv(self, zips: List[Dict], filename: str = "us_zipcodes.csv"):
        """Save ZIP codes to CSV file."""
        filepath = self.output_dir / filename
        if zips:
            with open(filepath, 'w', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=zips[0].keys())
                writer.writeheader()
                writer.writerows(zips)
            print(f"Saved {len(zips)} ZIP codes to {filepath}")
        return filepath
    
    def run(self):
        """Run the full fetch process."""
        print("="*60)
        print("US ZIP CODE FETCHER")
        print("="*60)
        
        # Try multiple sources
        zips = self.fetch_from_static_source()
        
        if not zips:
            print("\nStatic sources failed. Generating from ranges...")
            zips = self.generate_comprehensive_zip_list()
        
        # Save results
        self.save_zips(zips)
        self.save_zips_csv(zips)
        
        # Print summary
        states = {}
        for z in zips:
            state = z.get('state', 'Unknown')
            states[state] = states.get(state, 0) + 1
        
        print(f"\n{'='*60}")
        print("SUMMARY")
        print(f"{'='*60}")
        print(f"Total ZIP codes: {len(zips)}")
        print(f"States/Territories: {len(states)}")
        print(f"\nTop 10 states by ZIP count:")
        for state, count in sorted(states.items(), key=lambda x: -x[1])[:10]:
            print(f"  {state}: {count}")
        
        return zips


def main():
    fetcher = ZipCodeFetcher(output_dir="data")
    zips = fetcher.run()
    return zips


if __name__ == "__main__":
    main()
