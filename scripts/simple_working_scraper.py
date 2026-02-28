"""
Simple Working Property Scraper
===============================
Uses synchronous requests (like the working test scripts).
Slower but more reliable for no-proxy operation.

This approach mimics real browser requests more closely.
"""

import requests
import json
import csv
import time
import random
import argparse
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional
import re


class SimplePropertyScraper:
    """Simple scraper using synchronous requests."""
    
    def __init__(self, output_dir: str = "data/scraped_simple"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Create session with proper headers
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': 'https://www.redfin.com/',
            'X-RF-Stingray-Xhr': '1',
            'DNT': '1',
            'Connection': 'keep-alive',
        })
        
        # Prime the session
        self._prime_session()
        
        # Statistics
        self.stats = {
            'counties_attempted': 0,
            'counties_success': 0,
            'counties_failed': 0,
            'total_properties': 0,
        }
        
        # Progress tracking
        self.progress_file = self.output_dir / "progress.json"
        self.completed_counties = set()
        self.failed_counties = []
        self._load_progress()
    
    def _prime_session(self):
        """Visit Redfin to establish session cookies."""
        print("Priming session...")
        try:
            resp = self.session.get("https://www.redfin.com/", timeout=15)
            print(f"  Session primed: {resp.status_code}")
            time.sleep(2)
        except Exception as e:
            print(f"  Warning: Could not prime session: {e}")
    
    def _load_progress(self):
        """Load previous progress."""
        if self.progress_file.exists():
            with open(self.progress_file, 'r') as f:
                data = json.load(f)
                self.completed_counties = set(data.get('completed', []))
                self.failed_counties = data.get('failed', [])
                print(f"Resumed: {len(self.completed_counties)} counties already done")
    
    def _save_progress(self):
        """Save progress."""
        with open(self.progress_file, 'w') as f:
            json.dump({
                'completed': list(self.completed_counties),
                'failed': self.failed_counties,
                'stats': self.stats,
                'updated_at': datetime.now().isoformat()
            }, f, indent=2)
    
    def generate_counties(self) -> List[Dict]:
        """Fetch US counties from Census Bureau."""
        print("Fetching county list from Census Bureau...")
        url = "https://www2.census.gov/geo/docs/reference/codes/files/national_county.txt"
        
        try:
            response = requests.get(url, timeout=60)
            response.raise_for_status()
        except Exception as e:
            print(f"Failed to fetch counties: {e}")
            return []
        
        counties = []
        for line in response.text.strip().split('\n'):
            parts = line.split(',')
            if len(parts) >= 4:
                state = parts[0].strip()
                county_name = re.sub(
                    r'\s+(County|Parish|Borough|Census Area|Municipality|City and Borough|City)$',
                    '',
                    parts[3].strip(),
                    flags=re.IGNORECASE
                )
                counties.append({'name': county_name, 'state': state})
        
        print(f"Loaded {len(counties)} counties")
        return counties
    
    def search_county(self, county: Dict) -> Optional[Dict]:
        """Search for county on Redfin."""
        url = "https://www.redfin.com/stingray/do/location-autocomplete"
        
        queries = [
            f"{county['name']} County, {county['state']}",
            f"{county['name']}, {county['state']}",
        ]
        
        for query in queries:
            try:
                time.sleep(random.uniform(1.5, 2.5))  # Random delay
                
                response = self.session.get(
                    url,
                    params={'location': query, 'v': '2'},
                    timeout=15
                )
                
                if response.status_code == 200:
                    text = response.text
                    if text.startswith('{}&&'):
                        text = text[4:]
                    
                    data = json.loads(text)
                    sections = data.get('payload', {}).get('sections', [])
                    
                    all_rows = []
                    for section in sections:
                        all_rows.extend(section.get('rows', []))
                    
                    for row in all_rows:
                        # Look for county (type 5) or city (type 2)
                        if row.get('type') in [5, 2]:
                            full_id = row.get('id', '')
                            parts = full_id.split('_')
                            return {
                                'id': parts[-1],
                                'type': parts[0] if len(parts) > 1 else str(row.get('type', 5)),
                                'name': row.get('name', '')
                            }
                            
            except Exception as e:
                print(f"  Search error: {e}")
                continue
        
        return None
    
    def fetch_properties(self, region_id: str, region_type: str, days: int = 1825) -> List[Dict]:
        """Fetch properties for a region."""
        url = "https://www.redfin.com/stingray/api/gis-csv"
        params = {
            'al': 1,
            'region_id': region_id,
            'region_type': region_type,
            'sold_within_days': days,
            'status': '9',
            'v': 8
        }
        
        try:
            time.sleep(random.uniform(1.0, 2.0))
            
            response = self.session.get(url, params=params, timeout=60)
            
            if response.status_code == 200:
                text = response.text
                if len(text) < 100:
                    return []
                
                lines = text.splitlines()
                if not lines:
                    return []
                
                reader = csv.DictReader(lines)
                return [dict(row) for row in reader]
                
        except Exception as e:
            print(f"  Fetch error: {e}")
        
        return []
    
    def save_properties(self, county: Dict, properties: List[Dict]):
        """Save properties to disk."""
        if not properties:
            return
        
        # Save as JSON
        json_file = self.output_dir / "by_county" / f"{county['state'].lower()}_{county['name'].lower().replace(' ', '_')}.json"
        json_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(json_file, 'w') as f:
            json.dump(properties, f, indent=2)
        
        # Append to state CSV
        csv_file = self.output_dir / f"properties_{county['state'].lower()}.csv"
        file_exists = csv_file.exists()
        
        with open(csv_file, 'a', newline='', encoding='utf-8') as f:
            if properties:
                writer = csv.DictWriter(f, fieldnames=properties[0].keys())
                if not file_exists:
                    writer.writeheader()
                writer.writerows(properties)
    
    def scrape_counties(self, counties: List[Dict], days: int = 1825):
        """Scrape all counties."""
        total = len(counties)
        
        # Filter out completed
        pending = [c for c in counties if f"{c['name']}_{c['state']}" not in self.completed_counties]
        
        print("="*60)
        print("SIMPLE PROPERTY SCRAPER (Synchronous)")
        print("="*60)
        print(f"Total counties: {total}")
        print(f"Already completed: {len(counties) - len(pending)}")
        print(f"Pending: {len(pending)}")
        print(f"Estimated time: {len(pending) * 4 / 3600:.1f} - {len(pending) * 6 / 3600:.1f} hours")
        print("="*60)
        print("\nStarting scrape...")
        print("Press Ctrl+C to pause (you can resume later)")
        print("="*60 + "\n")
        
        if not pending:
            print("All counties already completed!")
            return
        
        start_time = time.time()
        last_save = time.time()
        
        try:
            for i, county in enumerate(pending, 1):
                self.stats['counties_attempted'] += 1
                county_key = f"{county['name']}_{county['state']}"
                
                # Search for region
                region = self.search_county(county)
                
                if not region:
                    self.failed_counties.append({
                        'county': county['name'],
                        'state': county['state'],
                        'error': 'region_not_found'
                    })
                    self.stats['counties_failed'] += 1
                    print(f"[{i}/{len(pending)}] ✗ {county['name']}, {county['state']} - region not found")
                    continue
                
                # Fetch properties
                properties = self.fetch_properties(region['id'], region['type'], days)
                
                if properties:
                    # Add metadata
                    for prop in properties:
                        prop['_source_county'] = county['name']
                        prop['_source_state'] = county['state']
                        prop['_scraped_at'] = datetime.now().isoformat()
                    
                    # Save
                    self.save_properties(county, properties)
                    
                    self.completed_counties.add(county_key)
                    self.stats['counties_success'] += 1
                    self.stats['total_properties'] += len(properties)
                    
                    print(f"[{i}/{len(pending)}] ✓ {county['name']}, {county['state']} - {len(properties)} properties")
                else:
                    self.failed_counties.append({
                        'county': county['name'],
                        'state': county['state'],
                        'error': 'no_properties'
                    })
                    self.stats['counties_failed'] += 1
                    print(f"[{i}/{len(pending)}] ✗ {county['name']}, {county['state']} - no properties")
                
                # Save progress every 10 counties or 60 seconds
                if (i % 10 == 0) or (time.time() - last_save > 60):
                    self._save_progress()
                    last_save = time.time()
                    
                    # Show progress
                    elapsed = time.time() - start_time
                    rate = i / elapsed if elapsed > 0 else 0
                    eta_seconds = (len(pending) - i) / rate if rate > 0 else 0
                    
                    print(f"\n--- PROGRESS: {i}/{len(pending)} ({i/len(pending)*100:.1f}%) | "
                          f"Rate: {rate*3600:.0f}/hour | ETA: {eta_seconds/3600:.1f}h | "
                          f"Properties: {self.stats['total_properties']:,} ---\n")
        
        except KeyboardInterrupt:
            print("\n\nScraping paused. Progress saved.")
            self._save_progress()
            return
        
        self._save_progress()
        self._print_stats()
    
    def _print_stats(self):
        """Print final statistics."""
        print("\n" + "="*60)
        print("FINAL STATISTICS")
        print("="*60)
        print(f"Counties attempted: {self.stats['counties_attempted']}")
        print(f"Counties successful: {self.stats['counties_success']}")
        print(f"Counties failed: {self.stats['counties_failed']}")
        print(f"Total properties: {self.stats['total_properties']:,}")
        print(f"\nData saved to: {self.output_dir}")


def main():
    parser = argparse.ArgumentParser(
        description='Simple working property scraper (slower but reliable)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Scrape all counties (slower but reliable)
  python simple_working_scraper.py
  
  # Specific state only
  python simple_working_scraper.py --state CA
  
  # Custom output directory
  python simple_working_scraper.py --output-dir my_data
        '''
    )
    
    parser.add_argument('--output-dir', default='data/scraped_simple',
                        help='Output directory')
    parser.add_argument('--state', help='Scrape specific state only')
    parser.add_argument('--days', type=int, default=1825,
                        help='Days to look back (default: 1825 = 5 years)')
    
    args = parser.parse_args()
    
    scraper = SimplePropertyScraper(output_dir=args.output_dir)
    counties = scraper.generate_counties()
    
    if args.state:
        counties = [c for c in counties if c['state'].upper() == args.state.upper()]
        print(f"Filtered to {len(counties)} counties in {args.state}")
    
    if not counties:
        print("No counties to scrape!")
        return
    
    scraper.scrape_counties(counties, args.days)


if __name__ == '__main__':
    main()
