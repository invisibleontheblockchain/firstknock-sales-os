"""
County-Based Batch Scraper
==========================
Scrapes by county (3,200) instead of ZIP (42,000) for 13x speed improvement.
Uses Redfin's county-level API which returns all properties in a county.

Key advantages:
- 3,200 counties vs 42,000 ZIP codes = 13x fewer requests
- Single request per county gets ALL properties
- Much more efficient for nationwide coverage

Expected time with 100 workers: 10-30 minutes

Usage:
    python county_batch_scraper.py --workers 100 --proxies proxies.txt
    python county_batch_scraper.py --state CA --workers 50
"""

import asyncio
import aiohttp
import aiofiles
import json
import csv
import re
import time
import argparse
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional, Set, Tuple
from dataclasses import dataclass, asdict
import ssl
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class County:
    """US County data."""
    name: str
    state: str
    fips: Optional[str] = None
    region_id: Optional[str] = None
    region_type: str = '5'  # Default to county type
    population: Optional[int] = None


class CountyBatchScraper:
    """High-speed county-based property scraper."""
    
    def __init__(
        self,
        proxy_file: Optional[str] = None,
        workers: int = 100,
        delay: float = 0.2,
        output_dir: str = "data/scraped_counties"
    ):
        self.workers = workers
        self.delay = delay
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # SSL context
        self.ssl_context = ssl.create_default_context()
        self.ssl_context.check_hostname = False
        self.ssl_context.verify_mode = ssl.CERT_NONE
        
        # Proxies
        self.proxies: List[str] = []
        if proxy_file and Path(proxy_file).exists():
            with open(proxy_file, 'r') as f:
                self.proxies = [line.strip() for line in f if line.strip() and not line.startswith('#')]
        self.current_proxy = 0
        self.use_proxies = len(self.proxies) > 0
        
        # Statistics
        self.stats = {
            'counties_attempted': 0,
            'counties_success': 0,
            'counties_failed': 0,
            'counties_skipped': 0,
            'total_properties': 0,
            'start_time': None,
            'end_time': None
        }
        
        # Progress tracking
        self.progress_file = self.output_dir / "county_progress.json"
        self.completed_counties: Set[str] = set()
        self.failed_counties: List[Dict] = []
        self.lock = asyncio.Lock()
        
        # Region ID cache
        self.region_cache_file = self.output_dir / "region_id_cache.json"
        self.region_cache: Dict[str, Dict] = {}
        self._load_cache()
        self._load_progress()
    
    def _load_cache(self):
        """Load region ID cache."""
        if self.region_cache_file.exists():
            with open(self.region_cache_file, 'r') as f:
                self.region_cache = json.load(f)
            logger.info(f"Loaded {len(self.region_cache)} cached region IDs")
    
    def _save_cache(self):
        """Save region ID cache."""
        with open(self.region_cache_file, 'w') as f:
            json.dump(self.region_cache, f, indent=2)
    
    def _load_progress(self):
        """Load scraping progress."""
        if self.progress_file.exists():
            with open(self.progress_file, 'r') as f:
                data = json.load(f)
                self.completed_counties = set(data.get('completed', []))
                self.failed_counties = data.get('failed', [])
                logger.info(f"Loaded progress: {len(self.completed_counties)} completed")
    
    async def _save_progress(self):
        """Save progress."""
        async with self.lock:
            with open(self.progress_file, 'w') as f:
                json.dump({
                    'completed': list(self.completed_counties),
                    'failed': self.failed_counties,
                    'stats': self.stats,
                    'updated_at': datetime.now().isoformat()
                }, f, indent=2)
    
    def _get_proxy(self) -> Optional[str]:
        """Get next proxy."""
        if not self.use_proxies:
            return None
        proxy = self.proxies[self.current_proxy % len(self.proxies)]
        self.current_proxy += 1
        return proxy
    
    def _get_headers(self) -> Dict[str, str]:
        """Get request headers."""
        import random
        user_agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
        ]
        return {
            'User-Agent': random.choice(user_agents),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.redfin.com/',
        }
    
    def generate_us_counties(self) -> List[County]:
        """Generate list of all US counties from Census data."""
        # Import requests for sync call
        import requests
        
        logger.info("Fetching county data from Census Bureau...")
        url = "https://www2.census.gov/geo/docs/reference/codes/files/national_county.txt"
        
        try:
            response = requests.get(url, timeout=60)
            if response.status_code != 200:
                logger.error(f"Failed to fetch county data: {response.status_code}")
                return []
        except Exception as e:
            logger.error(f"Error fetching county data: {e}")
            return []
        
        counties = []
        lines = response.text.strip().split('\n')
        
        for line in lines:
            parts = line.split(',')
            if len(parts) >= 4:
                state = parts[0].strip()
                county_full = parts[3].strip()
                
                # Remove suffixes
                county_name = re.sub(
                    r'\s+(County|Parish|Borough|Census Area|Municipality|City and Borough|City)$',
                    '',
                    county_full,
                    flags=re.IGNORECASE
                )
                
                counties.append(County(
                    name=county_name,
                    state=state,
                    fips=parts[1] + parts[2]
                ))
        
        logger.info(f"Generated {len(counties)} counties")
        return counties
    
    def save_counties_json(self, counties: List[County], filepath: str = "data/us_counties.json"):
        """Save counties to JSON."""
        Path(filepath).parent.mkdir(parents=True, exist_ok=True)
        with open(filepath, 'w') as f:
            json.dump({
                'count': len(counties),
                'counties': [{'name': c.name, 'state': c.state, 'fips': c.fips} for c in counties]
            }, f, indent=2)
        logger.info(f"Saved counties to {filepath}")
    
    async def search_county(self, session: aiohttp.ClientSession, county: County, max_retries: int = 3) -> Optional[Dict]:
        """Search for county region ID."""
        # Check cache first
        cache_key = f"{county.name.lower()}_{county.state.lower()}"
        if cache_key in self.region_cache:
            return self.region_cache[cache_key]
        
        url = "https://www.redfin.com/stingray/do/location-autocomplete"
        
        # Try different search queries
        queries = [
            f"{county.name} County, {county.state}",
            f"{county.name}, {county.state}",
            f"{county.name} {county.state}"
        ]
        
        for query in queries:
            params = {'location': query, 'v': '2'}
            
            for attempt in range(max_retries):
                try:
                    await asyncio.sleep(self.delay)
                    
                    async with session.get(
                        url,
                        params=params,
                        headers=self._get_headers(),
                        proxy=self._get_proxy(),
                        ssl=self.ssl_context,
                        timeout=aiohttp.ClientTimeout(total=15)
                    ) as response:
                        if response.status == 200:
                            text = await response.text()
                            if text.startswith('{}&&'):
                                text = text[4:]
                            
                            data = json.loads(text)
                            sections = data.get('payload', {}).get('sections', [])
                            
                            all_rows = []
                            for section in sections:
                                all_rows.extend(section.get('rows', []))
                            
                            for row in all_rows:
                                # Look for county type (5) or city type (2)
                                if row.get('type') in [5, 2]:
                                    full_id = row.get('id', '')
                                    parts = full_id.split('_')
                                    region_id = parts[-1]
                                    region_type = parts[0] if len(parts) > 1 else str(row.get('type', 5))
                                    
                                    result = {
                                        'id': region_id,
                                        'type': region_type,
                                        'name': row.get('name', '')
                                    }
                                    
                                    # Cache result
                                    self.region_cache[cache_key] = result
                                    return result
                                    
                except Exception as e:
                    if attempt == max_retries - 1:
                        logger.debug(f"Failed to search {county.name}, {county.state}: {e}")
        
        return None
    
    async def fetch_county_properties(
        self,
        session: aiohttp.ClientSession,
        region_id: str,
        region_type: str,
        days: int = 1825,
        max_retries: int = 3
    ) -> List[Dict]:
        """Fetch all properties for a county."""
        url = "https://www.redfin.com/stingray/api/gis-csv"
        params = {
            'al': 1,
            'region_id': region_id,
            'region_type': region_type,
            'sold_within_days': days,
            'status': '9',
            'v': 8
        }
        
        for attempt in range(max_retries):
            try:
                await asyncio.sleep(self.delay)
                
                async with session.get(
                    url,
                    params=params,
                    headers=self._get_headers(),
                    proxy=self._get_proxy(),
                    ssl=self.ssl_context,
                    timeout=aiohttp.ClientTimeout(total=120)  # Longer timeout for big counties
                ) as response:
                    if response.status == 200:
                        text = await response.text()
                        if len(text) < 100:
                            return []
                        
                        # Parse CSV
                        lines = text.splitlines()
                        if not lines:
                            return []
                        
                        reader = csv.DictReader(lines)
                        return [dict(row) for row in reader]
                        
            except asyncio.TimeoutError:
                logger.debug(f"Timeout for region {region_id}, attempt {attempt + 1}")
            except Exception as e:
                logger.debug(f"Error fetching region {region_id}: {e}")
        
        return []
    
    async def scrape_county(self, session: aiohttp.ClientSession, county: County, days: int = 1825) -> Tuple[List[Dict], str]:
        """Scrape a single county."""
        county_key = f"{county.name}_{county.state}"
        
        # Check if already completed
        if county_key in self.completed_counties:
            return [], 'already_completed'
        
        async with self.lock:
            self.stats['counties_attempted'] += 1
        
        # Search for region
        region = await self.search_county(session, county)
        
        if not region:
            async with self.lock:
                self.failed_counties.append({
                    'county': county.name,
                    'state': county.state,
                    'error': 'region_not_found'
                })
                self.stats['counties_failed'] += 1
            return [], 'region_not_found'
        
        # Fetch properties
        properties = await self.fetch_county_properties(
            session,
            region['id'],
            region['type'],
            days
        )
        
        if properties:
            # Add metadata
            for prop in properties:
                prop['_source_county'] = county.name
                prop['_source_state'] = county.state
                prop['_scraped_at'] = datetime.now().isoformat()
            
            async with self.lock:
                self.completed_counties.add(county_key)
                self.stats['counties_success'] += 1
                self.stats['total_properties'] += len(properties)
            
            return properties, 'success'
        else:
            async with self.lock:
                self.failed_counties.append({
                    'county': county.name,
                    'state': county.state,
                    'error': 'no_properties'
                })
                self.stats['counties_failed'] += 1
            return [], 'no_properties'
    
    async def save_county_properties(self, county: County, properties: List[Dict]):
        """Save county properties."""
        if not properties:
            return
        
        # Save as JSON
        json_file = self.output_dir / "by_county" / f"{county.state.lower()}_{county.name.lower().replace(' ', '_')}.json"
        json_file.parent.mkdir(parents=True, exist_ok=True)
        
        async with aiofiles.open(json_file, 'w') as f:
            await f.write(json.dumps(properties, indent=2))
        
        # Append to state CSV
        csv_file = self.output_dir / f"properties_{county.state.lower()}.csv"
        file_exists = csv_file.exists()
        
        async with aiofiles.open(csv_file, 'a', newline='') as f:
            if not file_exists and properties:
                header = ','.join(f'"{k}"' for k in properties[0].keys()) + '\n'
                await f.write(header)
            
            for prop in properties:
                row = ','.join(f'"{str(v).replace(chr(34), chr(34)+chr(34))}"' for v in prop.values()) + '\n'
                await f.write(row)
    
    async def worker(self, session: aiohttp.ClientSession, queue: asyncio.Queue, days: int):
        """Worker to process counties."""
        while True:
            try:
                county = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                break
            
            if county is None:
                break
            
            properties, status = await self.scrape_county(session, county, days)
            
            if properties:
                await self.save_county_properties(county, properties)
                logger.info(f"✓ {county.name}, {county.state}: {len(properties)} properties")
            elif status != 'already_completed':
                logger.debug(f"✗ {county.name}, {county.state}: {status}")
            
            queue.task_done()
    
    async def scrape_counties(self, counties: List[County], days: int = 1825):
        """Scrape all counties."""
        total = len(counties)
        self.stats['start_time'] = time.time()
        
        logger.info("="*60)
        logger.info("COUNTY BATCH SCRAPER")
        logger.info("="*60)
        logger.info(f"Total counties: {total}")
        logger.info(f"Workers: {self.workers}")
        logger.info(f"Estimated time: {(total / self.workers * self.delay / 60):.1f} minutes")
        logger.info("="*60)
        
        # Filter completed
        pending = [
            c for c in counties
            if f"{c.name}_{c.state}" not in self.completed_counties
        ]
        
        logger.info(f"Pending counties: {len(pending)} (completed: {len(self.completed_counties)})")
        
        if not pending:
            logger.info("All counties already completed!")
            return
        
        # Create work queue
        queue = asyncio.Queue(maxsize=self.workers * 2)
        
        # Create connector
        connector = aiohttp.TCPConnector(
            limit=self.workers * 2,
            limit_per_host=self.workers
        )
        
        async with aiohttp.ClientSession(connector=connector) as session:
            # Start workers
            workers = [
                asyncio.create_task(self.worker(session, queue, days))
                for _ in range(self.workers)
            ]
            
            # Fill queue
            for county in pending:
                await queue.put(county)
            
            # Progress reporter
            last_count = 0
            while not queue.empty():
                await asyncio.sleep(10)
                current = len(self.completed_counties)
                if current > last_count:
                    elapsed = time.time() - self.stats['start_time']
                    rate = current / elapsed if elapsed > 0 else 0
                    remaining = (len(pending) - current) / rate if rate > 0 else 0
                    
                    logger.info(
                        f"Progress: {current}/{len(pending)} counties | "
                        f"Properties: {self.stats['total_properties']} | "
                        f"Rate: {rate*60:.1f} counties/min | "
                        f"ETA: {remaining/60:.1f} min"
                    )
                    last_count = current
                    await self._save_progress()
            
            # Wait for completion
            await queue.join()
            
            # Stop workers
            for _ in range(self.workers):
                await queue.put(None)
            
            await asyncio.gather(*workers, return_exceptions=True)
        
        self.stats['end_time'] = time.time()
        await self._save_progress()
        self._save_cache()
        self._print_stats()
    
    def _print_stats(self):
        """Print final statistics."""
        elapsed = self.stats['end_time'] - self.stats['start_time']
        
        logger.info("\n" + "="*60)
        logger.info("FINAL STATISTICS")
        logger.info("="*60)
        logger.info(f"Elapsed time: {elapsed/60:.1f} minutes ({elapsed/3600:.2f} hours)")
        logger.info(f"Counties attempted: {self.stats['counties_attempted']}")
        logger.info(f"Counties successful: {self.stats['counties_success']}")
        logger.info(f"Counties failed: {self.stats['counties_failed']}")
        logger.info(f"Total properties: {self.stats['total_properties']:,}")
        logger.info(f"Average per county: {self.stats['total_properties']/max(self.stats['counties_success'],1):.0f}")
        logger.info(f"Rate: {self.stats['counties_attempted']/(elapsed/60):.1f} counties/minute")


def main():
    parser = argparse.ArgumentParser(
        description='High-speed county-based property scraper',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Scrape all counties with 100 workers
  python county_batch_scraper.py --workers 100 --proxies proxies.txt
  
  # Scrape specific state
  python county_batch_scraper.py --state CA --workers 50
  
  # Resume interrupted scrape
  python county_batch_scraper.py --resume --workers 100
        '''
    )
    
    parser.add_argument('--workers', type=int, default=100,
                        help='Number of concurrent workers (default: 100)')
    parser.add_argument('--proxies', help='Path to proxy list')
    parser.add_argument('--delay', type=float, default=0.2,
                        help='Delay between requests (default: 0.2)')
    parser.add_argument('--days', type=int, default=1825,
                        help='Days to look back (default: 1825 = 5 years)')
    parser.add_argument('--output-dir', default='data/scraped_counties',
                        help='Output directory')
    parser.add_argument('--state', help='Scrape specific state only')
    parser.add_argument('--resume', action='store_true',
                        help='Resume from previous run')
    
    args = parser.parse_args()
    
    scraper = CountyBatchScraper(
        proxy_file=args.proxies,
        workers=args.workers,
        delay=args.delay,
        output_dir=args.output_dir
    )
    
    # Generate or load counties
    counties_file = Path("data/us_counties.json")
    if counties_file.exists() and not args.resume:
        with open(counties_file, 'r') as f:
            data = json.load(f)
        counties = [County(c['name'], c['state'], c.get('fips')) for c in data['counties']]
    else:
        counties = scraper.generate_us_counties()
        scraper.save_counties_json(counties)
    
    # Filter by state if specified
    if args.state:
        counties = [c for c in counties if c.state.upper() == args.state.upper()]
        logger.info(f"Filtered to {len(counties)} counties in {args.state}")
    
    # Run scraper
    asyncio.run(scraper.scrape_counties(counties, args.days))


if __name__ == '__main__':
    main()
