"""
Nationwide Property Scraper for Redfin
=====================================
Scrapes property data for all US ZIP codes with:
- Progress tracking and resume capability
- Rate limiting and error handling
- Parallel processing support
- Database integration

Usage:
    python nationwide_property_scraper.py --mode all --output-dir data/scraped
    python nationwide_property_scraper.py --mode resume --state CA
    python nationwide_property_scraper.py --mode single --zip 90210
"""

import requests
import json
import csv
import os
import time
import argparse
import hashlib
from datetime import datetime
from typing import List, Dict, Optional, Tuple, Set
from pathlib import Path
from dataclasses import dataclass, asdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading


@dataclass
class ScrapingProgress:
    """Track scraping progress for resume capability."""
    total_zips: int = 0
    completed_zips: int = 0
    failed_zips: int = 0
    total_properties: int = 0
    current_zip: str = ""
    current_state: str = ""
    started_at: str = ""
    last_updated: str = ""
    completed_zip_codes: List[str] = None
    failed_zip_codes: List[Dict] = None
    
    def __post_init__(self):
        if self.completed_zip_codes is None:
            self.completed_zip_codes = []
        if self.failed_zip_codes is None:
            self.failed_zip_codes = []
    
    def to_dict(self) -> Dict:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'ScrapingProgress':
        return cls(**data)


class RedfinNationwideScraper:
    """
    Nationwide property scraper for Redfin with resume capability.
    """
    
    # Pre-defined region IDs for frequently accessed areas
    REGION_ID_CACHE = {
        # California
        ('los angeles', 'ca'): {'id': '471', 'type': '5'},
        ('san diego', 'ca'): {'id': '510', 'type': '5'},
        ('orange', 'ca'): {'id': '500', 'type': '5'},
        ('san francisco', 'ca'): {'id': '527', 'type': '5'},
        ('riverside', 'ca'): {'id': '515', 'type': '5'},
        ('san bernardino', 'ca'): {'id': '517', 'type': '5'},
        # Texas
        ('harris', 'tx'): {'id': '1931', 'type': '5'},
        ('dallas', 'tx'): {'id': '1829', 'type': '5'},
        ('travis', 'tx'): {'id': '2045', 'type': '5'},
        ('bexar', 'tx'): {'id': '1780', 'type': '5'},
        # Florida
        ('miami-dade', 'fl'): {'id': '1227', 'type': '5'},
        ('broward', 'fl'): {'id': '1059', 'type': '5'},
        ('palm beach', 'fl'): {'id': '1529', 'type': '5'},
        # New York
        ('kings', 'ny'): {'id': '1489', 'type': '5'},
        ('queens', 'ny'): {'id': '1618', 'type': '5'},
        # Add more as discovered
    }
    
    def __init__(
        self,
        delay: float = 2.0,
        output_dir: str = "data/scraped",
        progress_file: str = "data/scraping_progress.json",
        max_retries: int = 3,
        workers: int = 1
    ):
        self.delay = delay
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.progress_file = Path(progress_file)
        self.progress_file.parent.mkdir(parents=True, exist_ok=True)
        self.max_retries = max_retries
        self.workers = workers
        
        # Thread-safe lock for shared resources
        self.lock = threading.Lock()
        
        # Initialize session
        self.session = requests.Session()
        self._rotate_user_agent()
        
        # Load or initialize progress
        self.progress = self._load_progress()
        
        # Statistics
        self.stats = {
            'zips_attempted': 0,
            'zips_success': 0,
            'zips_failed': 0,
            'zips_skipped': 0,
            'total_properties': 0,
            'api_errors': 0,
            'rate_limited': 0
        }
    
    def _rotate_user_agent(self):
        """Rotate user agent to avoid blocking."""
        user_agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
        ]
        import random
        ua = random.choice(user_agents)
        
        self.session.headers.update({
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Cache-Control': 'max-age=0',
            'Referer': 'https://www.redfin.com/',
        })
    
    def _load_progress(self) -> ScrapingProgress:
        """Load scraping progress from file."""
        if self.progress_file.exists():
            try:
                with open(self.progress_file, 'r') as f:
                    data = json.load(f)
                print(f"Loaded progress file: {self.progress_file}")
                print(f"  Previously completed: {len(data.get('completed_zip_codes', []))} ZIP codes")
                return ScrapingProgress.from_dict(data)
            except Exception as e:
                print(f"Warning: Could not load progress file: {e}")
        
        return ScrapingProgress(
            started_at=datetime.now().isoformat(),
            last_updated=datetime.now().isoformat()
        )
    
    def _save_progress(self):
        """Save current progress to file."""
        self.progress.last_updated = datetime.now().isoformat()
        with self.lock:
            with open(self.progress_file, 'w') as f:
                json.dump(self.progress.to_dict(), f, indent=2)
    
    def _is_zip_completed(self, zip_code: str) -> bool:
        """Check if a ZIP code has already been processed."""
        return zip_code in self.progress.completed_zip_codes
    
    def _mark_zip_completed(self, zip_code: str, property_count: int):
        """Mark a ZIP code as completed."""
        with self.lock:
            if zip_code not in self.progress.completed_zip_codes:
                self.progress.completed_zip_codes.append(zip_code)
                self.progress.completed_zips += 1
                self.progress.total_properties += property_count
                self._save_progress()
    
    def _mark_zip_failed(self, zip_code: str, error: str):
        """Mark a ZIP code as failed."""
        with self.lock:
            self.progress.failed_zip_codes.append({
                'zip': zip_code,
                'error': error,
                'timestamp': datetime.now().isoformat()
            })
            self.progress.failed_zips += 1
            self._save_progress()
    
    def load_zip_codes(self, filepath: str = "data/us_zipcodes.json") -> List[Dict]:
        """Load ZIP codes from file."""
        path = Path(filepath)
        if not path.exists():
            print(f"ZIP codes file not found: {filepath}")
            print("Run fetch_us_zipcodes.py first to generate the ZIP code list.")
            return []
        
        with open(path, 'r') as f:
            data = json.load(f)
        
        zips = data.get('zip_codes', [])
        print(f"Loaded {len(zips)} ZIP codes from {filepath}")
        return zips
    
    def search_location(self, query: str, max_retries: int = 3) -> Optional[Dict]:
        """
        Search for a location using Redfin's autocomplete.
        Returns region ID and type for the location.
        """
        url = "https://www.redfin.com/stingray/do/location-autocomplete"
        params = {'location': query, 'v': '2'}
        
        for attempt in range(max_retries):
            try:
                response = self.session.get(url, params=params, timeout=15)
                
                if response.status_code == 403:
                    self.stats['rate_limited'] += 1
                    time.sleep(5 * (attempt + 1))
                    self._rotate_user_agent()
                    continue
                
                if response.status_code == 200:
                    text = response.text
                    if text.startswith('{}&&'):
                        text = text[4:]
                    
                    data = json.loads(text)
                    sections = data.get('payload', {}).get('sections', [])
                    
                    all_rows = []
                    for section in sections:
                        all_rows.extend(section.get('rows', []))
                    
                    if not all_rows:
                        return None
                    
                    # Find best match
                    best_match = None
                    query_upper = query.upper()
                    
                    for row in all_rows:
                        row_name = row.get('name', '').upper()
                        if query_upper in row_name or row_name in query_upper:
                            best_match = row
                            break
                    
                    if not best_match:
                        best_match = all_rows[0]
                    
                    full_id = best_match.get('id', '')
                    parts = full_id.split('_')
                    region_id = parts[-1]
                    region_type = parts[0] if len(parts) > 1 else best_match.get('type', '1')
                    
                    return {
                        'id': region_id,
                        'type': region_type,
                        'name': best_match.get('name'),
                        'full_id': full_id
                    }
                
            except requests.exceptions.RequestException as e:
                if attempt < max_retries - 1:
                    time.sleep(2 * (attempt + 1))
                else:
                    self.stats['api_errors'] += 1
            except Exception as e:
                self.stats['api_errors'] += 1
                return None
        
        return None
    
    def fetch_properties_csv(
        self,
        region_id: str,
        region_type: str,
        days: int = 1825,
        max_retries: int = 3
    ) -> List[Dict]:
        """
        Fetch properties using Redfin's CSV export API.
        This is the most reliable method for bulk data.
        """
        url = "https://www.redfin.com/stingray/api/gis-csv"
        params = {
            'al': 1,
            'region_id': region_id,
            'region_type': region_type,
            'sold_within_days': days,
            'status': '9',  # Sold
            'v': 8
        }
        
        for attempt in range(max_retries):
            try:
                response = self.session.get(url, params=params, timeout=45)
                
                if response.status_code == 403:
                    self.stats['rate_limited'] += 1
                    time.sleep(5 * (attempt + 1))
                    self._rotate_user_agent()
                    continue
                
                if response.status_code == 200:
                    text = response.text
                    if len(text) < 100:
                        return []
                    
                    # Parse CSV
                    reader = csv.DictReader(text.splitlines())
                    properties = []
                    for row in reader:
                        # Clean up the data
                        prop = {k.strip(): v.strip() if v else '' for k, v in row.items()}
                        properties.append(prop)
                    
                    return properties
                
            except requests.exceptions.Timeout:
                if attempt < max_retries - 1:
                    time.sleep(5)
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2)
        
        return []
    
    def fetch_properties_for_zip(
        self,
        zip_code: str,
        days: int = 1825
    ) -> Tuple[List[Dict], Dict]:
        """
        Fetch all properties for a ZIP code.
        Returns properties and metadata.
        """
        # Check if already completed
        if self._is_zip_completed(zip_code):
            self.stats['zips_skipped'] += 1
            return [], {'status': 'skipped', 'reason': 'already_completed'}
        
        self.stats['zips_attempted'] += 1
        
        try:
            # Search for the ZIP code
            location = self.search_location(zip_code)
            
            if not location:
                self._mark_zip_failed(zip_code, "Location not found")
                self.stats['zips_failed'] += 1
                return [], {'status': 'failed', 'reason': 'location_not_found'}
            
            # Fetch properties
            properties = self.fetch_properties_csv(
                location['id'],
                location['type'],
                days
            )
            
            if properties:
                # Add metadata
                for prop in properties:
                    prop['_source_zip'] = zip_code
                    prop['_scraped_at'] = datetime.now().isoformat()
                
                self.stats['zips_success'] += 1
                self.stats['total_properties'] += len(properties)
                self._mark_zip_completed(zip_code, len(properties))
                
                return properties, {
                    'status': 'success',
                    'count': len(properties),
                    'region_id': location['id'],
                    'region_type': location['type']
                }
            else:
                self._mark_zip_failed(zip_code, "No properties found")
                self.stats['zips_failed'] += 1
                return [], {'status': 'failed', 'reason': 'no_properties'}
            
        except Exception as e:
            self._mark_zip_failed(zip_code, str(e))
            self.stats['zips_failed'] += 1
            return [], {'status': 'error', 'error': str(e)}
    
    def save_properties(
        self,
        properties: List[Dict],
        zip_code: str,
        subdir: str = "by_zip"
    ):
        """Save properties to disk."""
        if not properties:
            return
        
        # Create subdirectory
        save_dir = self.output_dir / subdir
        save_dir.mkdir(parents=True, exist_ok=True)
        
        # Save as JSON
        json_file = save_dir / f"{zip_code}.json"
        with open(json_file, 'w') as f:
            json.dump(properties, f, indent=2)
        
        # Save as CSV (append to state file)
        state = properties[0].get('STATE OR PROVINCE', 'UNK')
        csv_file = self.output_dir / f"properties_{state.lower()}.csv"
        
        file_exists = csv_file.exists()
        with open(csv_file, 'a', newline='') as f:
            if properties:
                writer = csv.DictWriter(f, fieldnames=properties[0].keys())
                if not file_exists:
                    writer.writeheader()
                writer.writerows(properties)
    
    def scrape_single_zip(self, zip_code: str, days: int = 1825):
        """Scrape a single ZIP code."""
        print(f"\n{'='*60}")
        print(f"Scraping ZIP: {zip_code}")
        print(f"{'='*60}")
        
        properties, meta = self.fetch_properties_for_zip(zip_code, days)
        
        if properties:
            self.save_properties(properties, zip_code)
            print(f"✓ Saved {len(properties)} properties")
        else:
            print(f"✗ No properties found ({meta.get('reason', 'unknown')})")
        
        return properties, meta
    
    def scrape_zips(
        self,
        zip_codes: List[str],
        days: int = 1825,
        batch_size: int = 100
    ):
        """
        Scrape multiple ZIP codes with progress tracking.
        """
        total = len(zip_codes)
        self.progress.total_zips = total
        
        print(f"\n{'='*60}")
        print(f"NATIONWIDE PROPERTY SCRAPER")
        print(f"{'='*60}")
        print(f"Total ZIP codes to process: {total}")
        print(f"Already completed: {len(self.progress.completed_zip_codes)}")
        print(f"Delay between requests: {self.delay}s")
        print(f"{'='*60}\n")
        
        # Filter out already completed
        pending_zips = [
            z for z in zip_codes
            if z not in self.progress.completed_zip_codes
        ]
        
        print(f"Pending ZIP codes: {len(pending_zips)}")
        
        for i, zip_code in enumerate(pending_zips, 1):
            self.progress.current_zip = zip_code
            
            if i % 10 == 0:
                print(f"\n[{i}/{len(pending_zips)}] Processing {zip_code}...")
                self._print_progress()
            
            try:
                properties, meta = self.fetch_properties_for_zip(zip_code, days)
                
                if properties:
                    self.save_properties(properties, zip_code)
                    if i % 10 == 0:
                        print(f"  ✓ {len(properties)} properties")
                
                # Rate limiting
                if i < len(pending_zips):
                    time.sleep(self.delay)
                
                # Save progress every 50 ZIPs
                if i % 50 == 0:
                    self._save_progress()
                    
            except Exception as e:
                print(f"  ✗ Error: {e}")
                self._mark_zip_failed(zip_code, str(e))
        
        # Final save
        self._save_progress()
        self._print_final_stats()
    
    def scrape_by_state(
        self,
        state_code: str,
        zip_data: List[Dict],
        days: int = 1825
    ):
        """Scrape all ZIP codes for a specific state."""
        state_zips = [
            z['zip'] for z in zip_data
            if z.get('state', '').upper() == state_code.upper()
        ]
        
        print(f"\n{'='*60}")
        print(f"Scraping State: {state_code}")
        print(f"ZIP codes: {len(state_zips)}")
        print(f"{'='*60}")
        
        self.progress.current_state = state_code
        self.scrape_zips(state_zips, days)
    
    def _print_progress(self):
        """Print current progress."""
        completed = len(self.progress.completed_zip_codes)
        total = self.progress.total_zips
        pct = (completed / total * 100) if total > 0 else 0
        
        print(f"Progress: {completed}/{total} ({pct:.1f}%)")
        print(f"Properties: {self.progress.total_properties}")
        print(f"Failed: {self.progress.failed_zips}")
    
    def _print_final_stats(self):
        """Print final statistics."""
        print(f"\n{'='*60}")
        print("FINAL STATISTICS")
        print(f"{'='*60}")
        print(f"ZIP codes attempted: {self.stats['zips_attempted']}")
        print(f"ZIP codes successful: {self.stats['zips_success']}")
        print(f"ZIP codes failed: {self.stats['zips_failed']}")
        print(f"ZIP codes skipped: {self.stats['zips_skipped']}")
        print(f"Total properties: {self.stats['total_properties']}")
        print(f"API errors: {self.stats['api_errors']}")
        print(f"Rate limited: {self.stats['rate_limited']}")
        
        if self.progress.failed_zip_codes:
            print(f"\nFailed ZIP codes: {len(self.progress.failed_zip_codes)}")
            # Save failed ZIPs to file for retry
            failed_file = self.output_dir / "failed_zips.json"
            with open(failed_file, 'w') as f:
                json.dump(self.progress.failed_zip_codes, f, indent=2)
            print(f"Saved failed ZIPs to: {failed_file}")


def main():
    parser = argparse.ArgumentParser(
        description='Nationwide Property Scraper for Redfin',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Scrape all ZIP codes
  python nationwide_property_scraper.py --mode all
  
  # Scrape specific state
  python nationwide_property_scraper.py --mode state --state CA
  
  # Scrape single ZIP
  python nationwide_property_scraper.py --mode single --zip 90210
  
  # Resume interrupted scrape
  python nationwide_property_scraper.py --mode resume
  
  # Retry failed ZIPs
  python nationwide_property_scraper.py --mode retry-failed
        '''
    )
    
    parser.add_argument('--mode', required=True,
                        choices=['all', 'state', 'single', 'resume', 'retry-failed'],
                        help='Scraping mode')
    parser.add_argument('--state', help='State code (for state mode)')
    parser.add_argument('--zip', help='ZIP code (for single mode)')
    parser.add_argument('--days', type=int, default=1825,
                        help='Days to look back (default: 1825 = 5 years)')
    parser.add_argument('--delay', type=float, default=2.0,
                        help='Seconds between requests (default: 2.0)')
    parser.add_argument('--output-dir', default='data/scraped',
                        help='Output directory')
    parser.add_argument('--zip-file', default='data/us_zipcodes.json',
                        help='ZIP codes JSON file')
    parser.add_argument('--workers', type=int, default=1,
                        help='Number of parallel workers (default: 1)')
    
    args = parser.parse_args()
    
    # Validate arguments
    if args.mode == 'state' and not args.state:
        parser.error('--state required for state mode')
    if args.mode == 'single' and not args.zip:
        parser.error('--zip required for single mode')
    
    # Initialize scraper
    scraper = RedfinNationwideScraper(
        delay=args.delay,
        output_dir=args.output_dir,
        workers=args.workers
    )
    
    # Execute based on mode
    if args.mode == 'single':
        scraper.scrape_single_zip(args.zip, args.days)
    
    elif args.mode == 'all':
        zip_data = scraper.load_zip_codes(args.zip_file)
        if zip_data:
            all_zips = [z['zip'] for z in zip_data if z.get('zip')]
            scraper.scrape_zips(all_zips, args.days)
    
    elif args.mode == 'state':
        zip_data = scraper.load_zip_codes(args.zip_file)
        if zip_data:
            scraper.scrape_by_state(args.state, zip_data, args.days)
    
    elif args.mode == 'resume':
        zip_data = scraper.load_zip_codes(args.zip_file)
        if zip_data:
            all_zips = [z['zip'] for z in zip_data if z.get('zip')]
            scraper.scrape_zips(all_zips, args.days)
    
    elif args.mode == 'retry-failed':
        if scraper.progress.failed_zip_codes:
            failed_zips = [f['zip'] for f in scraper.progress.failed_zip_codes]
            print(f"Retrying {len(failed_zips)} failed ZIP codes...")
            scraper.scrape_zips(failed_zips, args.days)
        else:
            print("No failed ZIP codes to retry.")


if __name__ == '__main__':
    main()
